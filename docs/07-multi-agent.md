# 07 - 多 Agent 协作系统：最大深度分析

## 目录

1. [架构总览](#1-架构总览)
2. [AgentTool 的 6 种运行模式](#2-agenttool-的-6-种运行模式)
3. [Fork Agent 的缓存创新](#3-fork-agent-的缓存创新)
4. [Coordinator 模式详解](#4-coordinator-模式详解)
5. [Team 通信机制](#5-team-通信机制)
6. [Worktree 隔离](#6-worktree-隔离)
7. [Bridge 模块的真正用途](#7-bridge-模块的真正用途)
8. [shouldRunAsync 决策树](#8-shouldrunasync-决策树)

---

## 1. 架构总览

Claude Code 的多 Agent 协作系统由以下核心模块构成：

```
AgentTool.tsx (900+ 行)  ─── 统一入口，所有 Agent 生命周期管理
  ├── runAgent.ts          ─── 底层执行引擎：query() 循环 + MCP 初始化
  ├── forkSubagent.ts      ─── Fork 模式的消息构建与缓存策略
  ├── agentToolUtils.ts    ─── 工具池裁剪、异步生命周期管理
  ├── resumeAgent.ts       ─── 从磁盘 transcript 恢复后台 Agent
  ├── builtInAgents.ts     ─── 内置 Agent 注册表
  └── built-in/            ─── 6 个内置 Agent 定义

coordinatorMode.ts         ─── Coordinator 模式开关 + Worker 系统提示
spawnMultiAgent.ts         ─── Teammate 的 tmux/iTerm2/进程内生成
SendMessageTool.ts         ─── 跨 Agent 消息路由（本地/UDS/Bridge）
TeamCreateTool.ts          ─── 团队创建与 TeamFile 管理
worktree.ts                ─── Git Worktree 隔离：创建/检测变更/清理
bridge/ (31 files)         ─── Remote Control REPL 桥接（非 Agent 间通信）
```

---

## 2. AgentTool 的 6 种运行模式

### 模式对比表

| 维度 | 前台 (Sync) | 后台 (Async) | Fork | Worktree | Remote | Teammate |
|------|-------------|-------------|------|----------|--------|----------|
| **启动条件** | 默认模式 | `run_in_background=true` 或 `selectedAgent.background=true` | `subagent_type` 省略 + FORK_SUBAGENT feature gate | `isolation="worktree"` | `isolation="remote"` (ant-only) | 提供 `name` + `team_name` |
| **进程模型** | 同进程、阻塞父轮 | 同进程、异步 Promise | 同进程、强制异步 | 同进程 + 独立 git 目录 | 远程 CCR 环境 | tmux pane / iTerm2 tab / 进程内 |
| **上下文继承** | 无（全新 prompt） | 无 | 完整父上下文 + 系统提示 | 可叠加 Fork 上下文 | 无 | 无（通过 mailbox 通信） |
| **工具池** | `resolveAgentTools()` 裁剪 | 同上 + `ASYNC_AGENT_ALLOWED_TOOLS` 过滤 | 父级精确工具池 (`useExactTools`) | 同 Async | N/A | 独立工具池 |
| **缓存效率** | 独立缓存链 | 独立缓存链 | 与父共享 prompt cache | 独立 | 独立 | 独立 |
| **隔离级别** | 共享 CWD | 共享 CWD | 共享 CWD | 独立 worktree 目录 | 完全隔离沙箱 | 共享/独立 CWD |
| **权限模式** | 继承/覆盖 | `shouldAvoidPermissionPrompts` | `bubble` (浮到父终端) | 继承 | N/A | 继承 leader 模式 |
| **结果返回** | 直接返回 tool_result | `<task-notification>` 用户消息 | `<task-notification>` | `<task-notification>` + worktree 路径 | 远程轮询 | mailbox |

### 模式选择的核心路由逻辑

在 `AgentTool.call()` 中，路由决策按以下优先级执行：

```typescript
// 1. Teammate 路由 (最高优先级)
if (teamName && name) {
  return spawnTeammate({ ... })  // → tmux / in-process
}

// 2. Fork 路由
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : 'general-purpose')
const isForkPath = effectiveType === undefined  // subagent_type 省略 + gate 开启

// 3. Remote 隔离 (ant-only)
if ("external" === 'ant' && effectiveIsolation === 'remote') {
  return teleportToRemote({ ... })
}

// 4. Worktree 隔离
if (effectiveIsolation === 'worktree') {
  worktreeInfo = await createAgentWorktree(slug)
}

// 5. 同步/异步决策
const shouldRunAsync = (run_in_background || selectedAgent.background
  || isCoordinator || forceAsync || assistantForceAsync) && !isBackgroundTasksDisabled
```

---

## 3. Fork Agent 的缓存创新

### 3.1 核心设计目标

Fork 模式是 Claude Code 最精妙的缓存优化。其核心思想是：**让多个子 Agent 共享父级的 prompt cache，避免重复创建缓存**。

### 3.2 字节级 Prompt Cache 共享机制

关键约束：所有 Fork 子 Agent 必须产生**字节相同**的 API 请求前缀。实现方式：

**系统提示继承**：Fork 子 Agent 不使用自己的系统提示，而是直接继承父级已渲染的系统提示字节：

```typescript
// AgentTool.tsx 中的 Fork 路径
if (isForkPath) {
  if (toolUseContext.renderedSystemPrompt) {
    forkParentSystemPrompt = toolUseContext.renderedSystemPrompt  // 直接复用父级的已渲染字节
  } else {
    // Fallback: 重新计算（可能因 GrowthBook 状态变化而偏移，打破缓存）
    forkParentSystemPrompt = buildEffectiveSystemPrompt({ ... })
  }
}
```

**工具池精确复制**：Fork 使用 `useExactTools: true`，直接传递父级工具数组而非通过 `resolveAgentTools()` 重新构建：

```typescript
// Fork 路径传递精确工具
availableTools: isForkPath ? toolUseContext.options.tools : workerTools,
...(isForkPath && { useExactTools: true }),
```

这是因为 `resolveAgentTools()` 在 `permissionMode: 'bubble'` 下会产生与父级不同的工具定义序列化，导致缓存失效。

### 3.3 分叉消息的构建 (`buildForkedMessages`)

Fork 的消息结构精心设计以最大化缓存命中：

```
[...父级历史消息]
├── assistant (完整保留所有 tool_use, thinking, text blocks)
└── user
    ├── tool_result[0]: "Fork started — processing in background"  ← 所有子 Agent 相同
    ├── tool_result[1]: "Fork started — processing in background"  ← 所有子 Agent 相同
    ├── ...
    └── text: "<fork-boilerplate>...\n<fork-directive>只有这里不同</fork-directive>"  ← 唯一差异点
```

关键实现细节：

- **统一占位结果**: 所有 `tool_result` 使用相同的 `FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'`
- **分叉点位置**: 差异仅在最后一个 `user` 消息的最后一个 `text` block 中的 `<fork-directive>` 之后
- **递归保护**: `isInForkChild()` 检查消息中是否存在 `<fork-boilerplate>` 标签，防止 Fork 子 Agent 再次 Fork

### 3.4 Fork Boilerplate 的行为约束

子 Agent 收到的 `buildChildMessage()` 包含严格的行为指令（10 条不可违反规则）：

```
1. 系统提示说"默认 fork"——忽略它，你就是 fork。不要生成子 Agent
2. 不要对话或提问
5. 如果修改了文件，先提交再报告。报告中包含 commit hash
6. 工具调用之间不要输出文本。静默使用工具，最后报告一次
7. 严格在你的 directive 范围内。发现范围外的相关系统，最多一句话提及
9. 输出必须以 "Scope:" 开始
```

### 3.5 Worktree 叠加

Fork + Worktree 组合时，额外注入路径翻译通知：

```typescript
if (isForkPath && worktreeInfo) {
  promptMessages.push(createUserMessage({
    content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
  }))
}
```

`buildWorktreeNotice()` 告知子 Agent：继承的上下文路径指向父目录，需要翻译到 worktree 路径，并重新读取可能已过时的文件。

---

## 4. Coordinator 模式详解

### 4.1 启用条件

```typescript
// coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

需要同时满足：`COORDINATOR_MODE` feature flag 开启 + 环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1`。

**与 Fork 互斥**: `isForkSubagentEnabled()` 检查中明确排除 Coordinator 模式 -- Coordinator 有自己的委派模型。

### 4.2 完整的 Coordinator 系统提示

`getCoordinatorSystemPrompt()` 返回约 370 行的详细系统提示，核心结构：

```
## 1. Your Role
你是一个 **coordinator**。
- 帮助用户实现目标
- 指挥 worker 研究、实施和验证代码变更
- 综合结果并与用户沟通
- 能直接回答的问题不要委托

## 2. Your Tools
- Agent: 生成新 Worker
- SendMessage: 继续已有 Worker
- TaskStop: 停止运行中的 Worker

## 3. Workers
使用 subagent_type "worker"。Worker 自主执行任务。

## 4. Task Workflow (四阶段)
| Research (Workers) | Synthesis (YOU) | Implementation (Workers) | Verification (Workers) |

## 5. Writing Worker Prompts -- "永远不要委托理解"
## 6. Example Session
```

### 4.3 "永远不要委托理解"原则

这是 Coordinator 系统提示中最核心的设计哲学，体现在多个层面：

**系统提示中的显式约束**:

```
Never write "based on your findings" or "based on the research."
These phrases delegate understanding to the worker instead of doing it yourself.
You never hand off understanding to another worker.
```

**反模式示例**:
```
// 坏 — 懒惰委托
Agent({ prompt: "Based on your findings, fix the auth bug", ... })

// 好 — 综合后的精确指令
Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field
on Session is undefined when sessions expire but the token remains cached.
Add a null check before user.id access...", ... })
```

**Continue vs Spawn 决策矩阵**:

| 场景 | 机制 | 原因 |
|------|------|------|
| 研究探索的文件正是需要编辑的 | Continue (SendMessage) | Worker 已有文件上下文 |
| 研究广泛但实现范围窄 | Spawn 新 Worker | 避免拖入探索噪音 |
| 纠正失败或延续工作 | Continue | Worker 有错误上下文 |
| 验证另一个 Worker 写的代码 | Spawn 新 Worker | 验证者需要"新鲜眼光" |

### 4.4 Worker 工具池裁剪

```typescript
// coordinatorMode.ts
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,    // TeamCreate — Worker 不应创建团队
  TEAM_DELETE_TOOL_NAME,    // TeamDelete — Worker 不应删除团队
  SEND_MESSAGE_TOOL_NAME,   // SendMessage — Worker 不应直接通信
  SYNTHETIC_OUTPUT_TOOL_NAME // SyntheticOutput — 内部机制
])

// Worker 工具 = ASYNC_AGENT_ALLOWED_TOOLS - INTERNAL_WORKER_TOOLS
const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
  .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
  .sort()
  .join(', ')
```

Worker 的上下文注入通过 `getCoordinatorUserContext()` 实现，包含：
- 可用工具列表
- 连接的 MCP 服务器名称
- Scratchpad 目录路径（如果启用）

### 4.5 Coordinator 模式下的强制异步

```typescript
const shouldRunAsync = (... || isCoordinator || ...) && !isBackgroundTasksDisabled
```

在 Coordinator 模式下，所有 Worker 强制异步运行。结果通过 `<task-notification>` XML 格式的用户消息返回。

---

## 5. Team 通信机制

### 5.1 SendMessage 的寻址模式

`SendMessageTool` 支持四种寻址协议：

```typescript
const inputSchema = z.object({
  to: z.string()  // 寻址目标
  // 支持的格式：
  // "researcher"           → 按名称寻址 Teammate
  // "*"                    → 广播给所有 Teammates
  // "uds:/path/to.sock"   → Unix Domain Socket (本地跨会话)
  // "bridge:session_..."   → Remote Control 跨机器通信
})
```

### 5.2 消息路由的完整决策树

```
SendMessage.call(input)
│
├── 1. Bridge 路由 (feature UDS_INBOX + addr.scheme === 'bridge')
│   └── postInterClaudeMessage(target, message)  → 跨机器 HTTP API
│
├── 2. UDS 路由 (feature UDS_INBOX + addr.scheme === 'uds')
│   └── sendToUdsSocket(addr.target, message)    → Unix Domain Socket
│
├── 3. 子 Agent 路由 (名称或 agentId 匹配 agentNameRegistry/LocalAgentTask)
│   ├── task.status === 'running':
│   │   └── queuePendingMessage(agentId, message)  → 下一个工具轮次投递
│   ├── task.status === 已停止:
│   │   └── resumeAgentBackground(agentId, message) → 从 transcript 恢复
│   └── task 不存在:
│       └── resumeAgentBackground(agentId, message) → 尝试从磁盘恢复
│
├── 4. 广播路由 (to === '*')
│   └── handleBroadcast()  → 遍历 teamFile.members, writeToMailbox 每个
│
└── 5. Teammate 路由 (默认)
    └── handleMessage()    → writeToMailbox(recipientName, ...)
```

### 5.3 Mailbox 通信

Teammate 之间的通信基于文件系统 mailbox:

```typescript
// handleMessage 中的核心操作
await writeToMailbox(recipientName, {
  from: senderName,
  text: content,
  summary,
  timestamp: new Date().toISOString(),
  color: senderColor,
}, teamName)
```

Mailbox 文件存储在 team 目录下，每个 Teammate 有自己的收件箱。消息自动投递 -- 不需要主动检查收件箱。

### 5.4 tmux vs in-process 的选择策略

`spawnMultiAgent.ts` 中的后端检测逻辑：

```typescript
let detectionResult = await detectAndGetBackend()
// 检测结果可能包含: needsIt2Setup

// 后端类型 (BackendType):
// - 'tmux':       tmux 可用，创建 pane 并发送命令
// - 'iterm2':     iTerm2 + it2 工具，使用原生分屏
// - 'in-process': 进程内运行，共享内存

// tmux 生成流程:
// 1. ensureSession(sessionName)        → 确保 tmux session 存在
// 2. createTeammatePaneInSwarmView()   → 在 swarm 视图中创建 pane
// 3. sendCommandToPane(paneId, cmd)    → 向 pane 发送 spawn 命令
```

**进程内 Teammate 的特殊限制**:
```typescript
// 不能生成后台 Agent
if (isInProcessTeammate() && teamName && run_in_background === true) {
  throw new Error('In-process teammates cannot spawn background agents.')
}
// 不能生成嵌套 Teammate
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — the team roster is flat.')
}
```

### 5.5 结构化消息协议

除纯文本外，`SendMessage` 支持三种结构化消息：

```typescript
const StructuredMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown_request'), reason: z.string().optional() }),
  z.object({ type: z.literal('shutdown_response'), request_id, approve, reason }),
  z.object({ type: z.literal('plan_approval_response'), request_id, approve, feedback }),
])
```

- **shutdown_request**: 请求某个 Teammate 关闭（由 lead 发起）
- **shutdown_response**: Teammate 回复同意/拒绝关闭
- **plan_approval_response**: Lead 对 Teammate 提交的 plan 做出批准/拒绝

---

## 6. Worktree 隔离

### 6.1 创建流程

`createAgentWorktree(slug)` 的完整流程：

```
1. validateWorktreeSlug(slug)           → 防止路径遍历攻击
2. hasWorktreeCreateHook()?
   ├── 是: executeWorktreeCreateHook()  → 用户自定义 VCS 钩子
   └── 否: Git worktree 流程
       a. findCanonicalGitRoot()        → 找到主仓库（非嵌套 worktree）
       b. getOrCreateWorktree(root, slug)
          ├── readWorktreeHeadSha()     → 快速恢复路径（读 .git 指针文件，无子进程）
          ├── 如果已存在: 返回已有 worktree
          └── 如果不存在:
              i.   git fetch origin <defaultBranch>  (带 GIT_TERMINAL_PROMPT=0)
              ii.  git worktree add -B worktree-<slug> <path> <base>
              iii. (可选) git sparse-checkout set --cone -- <paths>
       c. symlinkDirectories()          → 符号链接 node_modules 等避免磁盘膨胀
       d. copyWorktreeIncludeFiles()    → 复制 .worktreeinclude 匹配的 gitignored 文件
       e. saveCurrentProjectConfig()    → 复制 CLAUDE.md 等配置
```

### 6.2 防止多 Agent Git 冲突

Worktree 通过以下机制防止冲突：

1. **分支隔离**: 每个 worktree 使用唯一分支名 `worktree-<flattenSlug>`
2. **目录隔离**: 路径为 `.claude/worktrees/<flattenSlug>`，物理上完全隔离
3. **`-B` 标志**: `git worktree add -B` 会重置同名孤儿分支，避免残留状态
4. **Slug 扁平化**: `user/feature` → `user+feature`，防止 git ref 的 D/F 冲突和嵌套 worktree 问题
5. **`findCanonicalGitRoot()`**: 确保所有 worktree 都在主仓库的 `.claude/worktrees/` 下创建，而非在已有 worktree 内嵌套

### 6.3 清理流程

```typescript
async cleanupWorktreeIfNeeded(): Promise<{ worktreePath?, worktreeBranch? }> {
  // Hook-based worktree: 始终保留（无法检测 VCS 变更）
  if (hookBased) return { worktreePath }

  // 检测变更: git status --porcelain + git rev-list --count <base>..HEAD
  if (headCommit) {
    const changed = await hasWorktreeChanges(worktreePath, headCommit)
    if (!changed) {
      // 无变更 → 自动清理
      await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
      return {}
    }
  }
  // 有变更 → 保留 worktree, 返回路径和分支供用户查看
  return { worktreePath, worktreeBranch }
}
```

`hasWorktreeChanges()` 检查两个维度：
- `git status --porcelain`: 检测未提交的修改
- `git rev-list --count <headCommit>..HEAD`: 检测新提交

---

## 7. Bridge 模块的真正用途

### 7.1 核心定位

**Bridge 不是 Agent 间通信机制，而是 Remote Control (远程控制) 的 REPL 桥接层。** 它使 claude.ai 网页端能够远程控制本地运行的 Claude Code 实例。

### 7.2 31 个文件功能分组

| 分组 | 文件 | 功能 |
|------|------|------|
| **核心桥接** | `replBridge.ts` | 主 REPL 桥接核心：环境注册、消息轮询、WebSocket 连接管理 |
| | `remoteBridgeCore.ts` | Env-less 桥接核心 (v2)：无 Environments API 直连 |
| | `bridgeMain.ts` | `claude remote-control` 命令入口：多会话管理、spawn 模式 |
| | `initReplBridge.ts` | REPL 特定初始化：读 bootstrap 状态、OAuth、会话标题 |
| **配置与启用** | `bridgeConfig.ts` | 桥接 URL、token 配置 |
| | `bridgeEnabled.ts` | GrowthBook gate 检查、最低版本验证 |
| | `envLessBridgeConfig.ts` | v2 无环境配置 |
| | `pollConfig.ts` / `pollConfigDefaults.ts` | 轮询间隔配置 |
| **API 层** | `bridgeApi.ts` | HTTP API 客户端：registerEnvironment, pollForWork, ack, stop |
| | `codeSessionApi.ts` | CCR v2 会话 API：创建会话、获取凭证 |
| | `createSession.ts` | 创建/归档桥接会话 |
| **消息处理** | `bridgeMessaging.ts` | 传输层消息解析：类型守卫、消息过滤、去重 |
| | `inboundMessages.ts` | 入站消息提取：内容和 UUID |
| | `inboundAttachments.ts` | 入站附件处理 |
| **传输** | `replBridgeTransport.ts` | v1 (WebSocket) 和 v2 (SSE+CCRClient) 传输层 |
| **安全与认证** | `jwtUtils.ts` | JWT 令牌管理：刷新调度 |
| | `trustedDevice.ts` | 受信设备令牌 |
| | `workSecret.ts` | Work Secret 解码、SDK URL 构建、worker 注册 |
| | `sessionIdCompat.ts` | 会话 ID 格式兼容转换 |
| **会话管理** | `sessionRunner.ts` | 子进程生成器：spawn Claude Code CLI 处理远程会话 |
| | `replBridgeHandle.ts` | 桥接句柄的全局注册与访问 |
| | `bridgePointer.ts` | 崩溃恢复指针：检测异常退出后恢复会话 |
| **UI 与调试** | `bridgeUI.ts` | 状态显示：banner, session 状态, QR 码 |
| | `bridgeStatusUtil.ts` | 格式化工具（时长等） |
| | `bridgeDebug.ts` | 故障注入与调试句柄 |
| | `debugUtils.ts` | 错误描述、HTTP 状态提取 |
| **流量管理** | `capacityWake.ts` | 容量唤醒信号：有新 work 时唤醒空闲轮询 |
| | `flushGate.ts` | 刷新门：确保消息按序发送 |
| **权限** | `bridgePermissionCallbacks.ts` | 权限回调注册 |
| **类型** | `types.ts` | 所有类型定义：WorkResponse, BridgeConfig, SessionHandle 等 |

### 7.3 两代架构

**v1 (Env-based)**: `replBridge.ts`
```
注册环境 → 轮询 Work → 确认 → 生成子进程 → WebSocket 通信 → 心跳
```

**v2 (Env-less)**: `remoteBridgeCore.ts`
```
POST /v1/code/sessions → POST /bridge (获取 JWT) → SSE + CCRClient
```

v2 移除了 Environments API 的 poll/dispatch 层，直接连接 session-ingress。

### 7.4 Spawn 模式

`bridgeMain.ts` 支持三种会话目录策略:

```typescript
type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
// single-session: 一个会话在 CWD，桥接随会话结束而销毁
// worktree: 持久服务，每个会话获得独立的 git worktree
// same-dir: 持久服务，所有会话共享 CWD（可能冲突）
```

---

## 8. shouldRunAsync 决策树

完整的异步决策逻辑：

```
shouldRunAsync =
  (
    run_in_background === true           // 用户显式要求后台
    || selectedAgent.background === true  // Agent 定义中声明后台
    || isCoordinator                      // Coordinator 模式强制异步
    || forceAsync                         // Fork 实验强制所有 spawn 异步
    || assistantForceAsync                // KAIROS 助手模式强制异步
    || proactiveModule?.isProactiveActive() // 主动模式活跃时强制异步
  )
  && !isBackgroundTasksDisabled          // 全局后台任务未被禁用
```

关键行为差异：

- **Sync Agent**: 阻塞父级 turn，直接返回 `AgentToolResult`
- **Async Agent**: 注册 `LocalAgentTask`，返回 `{ status: 'async_launched', agentId, outputFile }`
- **Async 完成后**: 通过 `enqueueAgentNotification()` 将结果注入为 `<task-notification>` 格式的 user-role 消息

### Auto-background 机制

```typescript
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS)
    || getFeatureValue('tengu_auto_background_agents', false)) {
    return 120_000  // 120 秒后自动转为后台
  }
  return 0
}
```

---

## 9. Agent 内存系统

`agentMemory.ts` 实现了三级持久化记忆：

```typescript
type AgentMemoryScope = 'user' | 'project' | 'local'
// user:    ~/.claude/agent-memory/<agentType>/    → 跨项目通用记忆
// project: <cwd>/.claude/agent-memory/<agentType>/ → 项目级共享记忆 (可 VCS)
// local:   <cwd>/.claude/agent-memory-local/<agentType>/ → 本地私有 (不入 VCS)
```

Agent 定义中通过 `memory: 'user' | 'project' | 'local'` frontmatter 声明使用哪个级别。系统自动在 Agent 启动时通过 `loadAgentMemoryPrompt()` 将记忆内容注入系统提示。

---

## 10. 内置 Agent 注册表

`builtInAgents.ts` 管理内置 Agent 的注册，模式取决于运行模式：

```typescript
function getBuiltInAgents(): AgentDefinition[] {
  // Coordinator 模式 → 使用 getCoordinatorAgents() (只有 worker)
  if (isCoordinatorMode()) return getCoordinatorAgents()

  // 普通模式:
  const agents = [
    GENERAL_PURPOSE_AGENT,   // 通用 Agent（必须）
    STATUSLINE_SETUP_AGENT,  // iTerm2 状态栏设置
  ]
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)  // 探索和计划 Agent
  }
  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)    // Claude Code 使用指南
  }
  if (feature('VERIFICATION_AGENT')) {
    agents.push(VERIFICATION_AGENT)         // 验证 Agent
  }
  return agents
}
```

特殊标记 `ONE_SHOT_BUILTIN_AGENT_TYPES`: `Explore` 和 `Plan` 是一次性 Agent，不需要 agentId/SendMessage 提示的尾部信息，节省约 135 字符/次。

---

## 总结

Claude Code 的多 Agent 系统是一个精密的分层架构：

1. **AgentTool 是统一入口**，通过 6 种运行模式覆盖从简单委托到完全隔离的所有场景
2. **Fork 模式是最大的缓存创新**，通过字节级系统提示继承和统一占位结果实现跨子 Agent 的 prompt cache 共享
3. **Coordinator 模式实现了"永不委托理解"的设计哲学**，通过详细的系统提示确保 Coordinator 始终做综合而非转发
4. **Worktree 提供 Git 级别的物理隔离**，配合智能清理避免磁盘膨胀
5. **Team 通信通过 mailbox + SendMessage 实现**，支持本地、UDS、跨机器三种传输
6. **Bridge 模块是 Remote Control 基础设施**，让 claude.ai 网页端能远程控制本地 Claude Code -- 它不是 Agent 间通信机制
