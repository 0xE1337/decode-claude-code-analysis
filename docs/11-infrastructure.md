# 11 - 基础设施模块深度分析

## 概述

Claude Code 的基础设施层由 tasks/、state/、remote/、migrations/、keybindings/、cli/、server/、vim/、upstreamproxy/、memdir/ 和 utils/ 等模块构成。这些模块横跨任务调度、状态管理、远程执行、模型演进、输入处理、代理服务、记忆系统等领域，是整个应用的底层骨架。以下按最大深度逐一解析。

---

## 一、Task 系统深度剖析

### 1.1 七种任务类型与生命周期

Task 系统定义在 `Task.ts`(基础类型) + `tasks.ts`(注册表) + `tasks/` 目录(各实现)中。核心类型层次：

```typescript
// Task.ts - 七种任务类型
export type TaskType =
  | 'local_bash'      // 前缀 'b' - 本地 Shell 命令
  | 'local_agent'     // 前缀 'a' - 本地 Agent 子任务
  | 'remote_agent'    // 前缀 'r' - 远程 CCR 会话
  | 'in_process_teammate' // 前缀 't' - 进程内队友
  | 'local_workflow'  // 前缀 'w' - 本地工作流(feature-gated)
  | 'monitor_mcp'     // 前缀 'm' - MCP 监控(feature-gated)
  | 'dream'           // 前缀 'd' - Dream 任务(记忆蒸馏)

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

**任务 ID 生成规则**：前缀字母 + 8 位 base36 随机字符（`randomBytes(8)` 映射到 `0-9a-z`），约 2.8 万亿组合防 symlink 碰撞攻击。主会话后台化任务使用 `'s'` 前缀区分。

**生命周期对比表**：

| 任务类型 | 触发方式 | 执行位置 | 输出存储 | 后台化 | kill 机制 |
|---------|---------|---------|---------|--------|----------|
| `local_bash` | BashTool/BackgroundBashTool | 本地子进程 | 独立 transcript 文件 | 支持 ctrl+b | 进程 SIGTERM |
| `local_agent` | AgentTool 调用 | 本地 query() 循环 | agent transcript 文件 | 支持 | AbortController.abort() |
| `remote_agent` | teleport/ultraplan | CCR 云容器 | CCR 服务端 | 始终后台 | WebSocket interrupt |
| `in_process_teammate` | Swarm 团队系统 | 同进程内 | 共享 AppState | 始终后台 | AbortController |
| `local_workflow` | feature('WORKFLOW_SCRIPTS') | 本地 | workflow 输出 | 支持 | AbortController |
| `monitor_mcp` | feature('MONITOR_TOOL') | MCP 连接 | MCP 事件流 | 始终后台 | 断开连接 |
| `dream` | 记忆蒸馏 /dream | 本地 sideQuery | 记忆目录 | 始终后台 | AbortController |

### 1.2 主会话后台化机制

`LocalMainSessionTask.ts`（480行）实现了一套完整的主会话后台化协议：

**触发流程**：用户双击 `Ctrl+B` -> `registerMainSessionTask()` 创建任务 -> `startBackgroundSession()` 将当前消息 fork 到独立 `query()` 调用。

```typescript
// 关键数据结构
export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'  // 区分普通 agent 任务
}
```

**核心设计**：
- **独立 transcript**：后台任务写入 `getAgentTranscriptPath(taskId)` 而非主会话 transcript，避免 `/clear` 后数据污染
- **Symlink 存活**：通过 `initTaskOutputAsSymlink()` 将 taskId 链接到独立文件，`/clear` 时 symlink 自动重链
- **AgentContext 隔离**：使用 `AsyncLocalStorage` 包装的 `runWithAgentContext()` 确保并发 query 之间 skill invocation 隔离
- **通知去重**：`notified` flag 原子检查设置（CAS），防止 abort 路径和 complete 路径双重通知
- **前台恢复**：`foregroundMainSessionTask()` 将任务标记为 `isBackgrounded: false`，同时恢复之前被前台化的任务到后台

### 1.3 Task 与 Agent 的关系

- `Task`（`Task.ts`）是调度单元，定义 `kill()` 接口和 ID 生成
- `Agent`（AgentTool）是执行单元，运行 query loop
- 关系：一个 `local_agent` Task 对应一个 Agent 实例；`in_process_teammate` 对应 swarm 中的一个成员；`remote_agent` 对应一个 CCR 云端会话
- `tasks.ts` 的 `getTaskByType()` 是多态分发入口，`stopTask.ts` 的 `stopTask()` 是统一终止入口

```typescript
// tasks.ts - 条件加载 feature-gated 任务
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
  : null
```

---

## 二、状态管理系统

### 2.1 Store 的 35 行极简实现

`state/store.ts` 是整个应用的状态管理核心——仅 35 行代码：

```typescript
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // 引用相等即跳过
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

**与 Redux/Zustand 的设计对比**：

| 特性 | Claude Code Store | Redux | Zustand |
|------|------------------|-------|---------|
| 核心代码量 | 35 行 | ~2000 行 | ~200 行 |
| 更新方式 | `setState(updater)` | `dispatch(action)` | `set(partial)` |
| 中间件 | 无 | 支持 | 支持 |
| 不可变性 | 约定式 (`DeepImmutable`) | 强制式 (reducer) | 约定式 |
| 变更检测 | `Object.is` 引用比较 | reducer 返回新对象 | `Object.is` |
| 副作用 | `onChange` 回调 | middleware/saga/thunk | subscribe |
| DevTools | 无 | 支持 | 支持 |

**设计选择理由**：Claude Code 是 TUI 应用，不需要 Redux 的 action log/time-travel；`onChange` 回调模式足够处理所有跨模块副作用；`DeepImmutable` 类型约束在编译期保证不可变性。

### 2.2 AppState 的超大结构（570 行）

`AppStateStore.ts` 定义了 `AppState` 类型，包含约 100+ 个顶层字段，覆盖以下功能域：

| 字段域 | 关键字段 | 说明 |
|--------|---------|------|
| 核心设置 | `settings`, `verbose`, `mainLoopModel` | 模型选择、设置 |
| 权限控制 | `toolPermissionContext`, `denialTracking` | 权限模式和拒绝追踪 |
| 任务系统 | `tasks`, `foregroundedTaskId`, `viewingAgentTaskId` | 任务注册表和视图状态 |
| MCP 系统 | `mcp.clients`, `mcp.tools`, `mcp.commands` | MCP 服务器连接 |
| 插件系统 | `plugins.enabled`, `plugins.installationStatus` | 插件管理 |
| Bridge 连接 | `replBridgeEnabled/Connected/SessionActive` (9个字段) | 远程控制桥 |
| 推测执行 | `speculation`, `speculationSessionTimeSavedMs` | 预测性执行缓存 |
| Computer Use | `computerUseMcpState` (12个子字段) | macOS CU 状态 |
| Tmux 集成 | `tungstenActiveSession`, `tungstenPanelVisible` | 终端面板 |
| 浏览器工具 | `bagelActive`, `bagelUrl`, `bagelPanelVisible` | WebBrowser 面板 |
| 团队协作 | `teamContext`, `inbox`, `workerSandboxPermissions` | Swarm 相关 |
| Ultraplan | `ultraplanLaunching/SessionUrl/PendingChoice` | 远程规划 |
| 记忆/通知 | `notifications`, `elicitation`, `promptSuggestion` | 交互状态 |

特别值得注意的是 `tasks` 字段被排除在 `DeepImmutable` 之外，因为 `TaskState` 包含函数类型（如 `abortController`）。

### 2.3 onChangeAppState 副作用处理

`onChangeAppState.ts` 是一个集中式副作用处理器，挂接在 Store 的 `onChange` 回调上。它的设计理念是"单一阻塞点"——所有 `setAppState` 调用触发的跨模块同步都在这里完成：

**处理的副作用链**：
1. **权限模式同步**（最复杂）：检测 `toolPermissionContext.mode` 变更 -> 外部化模式名（`bubble` -> `default`） -> 通知 CCR (`notifySessionMetadataChanged`) + SDK (`notifyPermissionModeChanged`)。此前有 8+ 个变更路径只有 2 个正确同步
2. **模型设置持久化**：`mainLoopModel` 变更 -> `updateSettingsForSource('userSettings', ...)` + `setMainLoopModelOverride()`
3. **展开视图持久化**：`expandedView` 变更 -> `saveGlobalConfig()` 写入 `showExpandedTodos`/`showSpinnerTree`
4. **verbose 持久化**：同步到 `globalConfig.verbose`
5. **Tungsten 面板**：`tungstenPanelVisible` 粘性开关持久化（ant-only）
6. **Auth 缓存清理**：`settings` 变更时清除 API key/AWS/GCP 凭证缓存
7. **环境变量重应用**：`settings.env` 变更时调用 `applyConfigEnvironmentVariables()`

### 2.4 Selector 与视图辅助

`selectors.ts` 提供纯函数从 AppState 派生计算值：
- `getViewedTeammateTask()` - 获取当前查看的队友任务
- `getActiveAgentForInput()` - 确定用户输入路由目标（leader/viewed/named_agent）

`teammateViewHelpers.ts` 管理队友 transcript 查看状态：
- `enterTeammateView()` - 进入查看（设置 `retain: true` 防止 eviction）
- `exitTeammateView()` - 退出（`release()` 清理消息，设置 `evictAfter` 延迟清理）
- `stopOrDismissAgent()` - 上下文敏感：running -> abort; terminal -> dismiss

---

## 三、模型演进追踪

### 3.1 迁移脚本完整列表

`migrations/` 目录包含 11 个迁移脚本，按功能分为三类：

**模型名称迁移（5 个）**：

| 脚本 | 迁移路径 | 条件 |
|------|---------|------|
| `migrateFennecToOpus.ts` | fennec-latest -> opus, fennec-fast-latest -> opus[1m]+fast | ant-only |
| `migrateLegacyOpusToCurrent.ts` | claude-opus-4-0/4-1 -> opus | firstParty + GB gate |
| `migrateOpusToOpus1m.ts` | opus -> opus[1m] | Max/Team Premium (非 Pro) |
| `migrateSonnet1mToSonnet45.ts` | sonnet[1m] -> sonnet-4-5-20250929[1m] | 一次性，globalConfig flag |
| `migrateSonnet45ToSonnet46.ts` | sonnet-4-5-20250929 -> sonnet | Pro/Max/Team Premium firstParty |

**设置迁移（5 个）**：

| 脚本 | 功能 |
|------|------|
| `migrateAutoUpdatesToSettings.ts` | globalConfig.autoUpdates -> settings.env.DISABLE_AUTOUPDATER |
| `migrateBypassPermissionsAcceptedToSettings.ts` | globalConfig -> settings.skipDangerousModePermissionPrompt |
| `migrateEnableAllProjectMcpServersToSettings.ts` | projectConfig MCP 审批 -> localSettings |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | replBridgeEnabled -> remoteControlAtStartup |
| `resetAutoModeOptInForDefaultOffer.ts` | 清除 skipAutoPermissionPrompt 以展示新选项 |

**默认模型重置（1 个）**：

| 脚本 | 功能 |
|------|------|
| `resetProToOpusDefault.ts` | Pro 用户自动迁移到 Opus 4.5 默认 |

### 3.2 模型命名演进时间线

从迁移脚本中可重建以下命名演进时间线：

```
时期 1（内部代号期）:
  fennec-latest          -> opus     (内部代号 fennec 过渡到公开 opus)
  fennec-latest[1m]      -> opus[1m]
  fennec-fast-latest     -> opus[1m] + fastMode
  opus-4-5-fast          -> opus + fastMode

时期 2（Opus 版本迭代）:
  claude-opus-4-20250514    (Opus 4.0，2025-05-14 发布)
  claude-opus-4-0           (短名)
  claude-opus-4-1-20250805  (Opus 4.1，2025-08-05 发布)
  claude-opus-4-1           (短名)
  -> 全部迁移至 'opus' 别名（指向 Opus 4.6）

时期 3（Opus 1M 合并）:
  opus -> opus[1m]  (Max/Team Premium 用户合并到 1M 版本)

时期 4（Sonnet 版本迭代）:
  sonnet[1m] -> sonnet-4-5-20250929[1m]  (Sonnet 别名开始指向 4.6)
  sonnet-4-5-20250929 -> sonnet           (最终全部迁移到 sonnet 别名)
```

### 3.3 模型别名系统

别名通过 `utils/model/aliases.ts` 实现，迁移脚本只操作 `userSettings.model` 字段。关键设计原则：
- 只迁移 `userSettings`（用户级），不碰 `projectSettings`/`localSettings`/`policySettings`
- 运行时仍由 `parseUserSpecifiedModel()` 做兜底重映射
- 通过 `globalConfig` 的完成标志位保证幂等

---

## 四、Utils 目录分类

`utils/` 目录包含 564 个文件（290 个顶层 + 274 个子目录内），总计约 88,466 行代码。按子目录分类：

### 4.1 子目录功能分类表

| 子目录 | 文件数 | 功能领域 |
|--------|--------|---------|
| `bash/` | 15+ | Bash 解析器（AST/heredoc/管道/quoting） |
| `shell/` | 10 | Shell provider 抽象（bash/powershell） |
| `powershell/` | 3 | PowerShell 危险 cmdlet 检测 |
| `permissions/` | 16+ | 权限系统（classifier/denial/filesystem/mode） |
| `model/` | 16 | 模型管理（alias/config/capability/deprecation/providers） |
| `settings/` | 14+ | 设置系统（cache/validation/MDM/policy） |
| `hooks/` | 16 | Hook 系统（API/agent/HTTP/prompt/session/file watcher） |
| `plugins/` | 15+ | 插件生态（install/load/recommend/LSP/telemetry） |
| `mcp/` | 2 | MCP 辅助（dateTime/elicitation） |
| `messages/` | 2 | 消息映射和系统初始化 |
| `task/` | 5 | 任务框架（diskOutput/framework/formatting/SDK progress） |
| `swarm/` | 14+ | 多 Agent 协作（backend/spawn/permission/layout） |
| `git/` | 3 | Git 操作（config/filesystem/gitignore） |
| `github/` | 1 | GitHub 认证状态 |
| `telemetry/` | 9 | 遥测（BigQuery/Perfetto/session tracing） |
| `teleport/` | 4 | 远程传送（CCR API/环境/git bundle） |
| `computerUse/` | 15 | macOS Computer Use（Swift/MCP/executor） |
| `claudeInChrome/` | 7 | Chrome 原生扩展 Host |
| `deepLink/` | 6 | 深度链接（协议/终端启动器） |
| `nativeInstaller/` | 5 | 原生安装（download/PID lock/包管理器） |
| `secureStorage/` | 6 | 安全存储（keychain/plainText fallback） |
| `sandbox/` | 2 | 沙箱适配和 UI 工具 |
| `dxt/` | 2 | DXT 插件格式（helper/zip） |
| `filePersistence/` | 2 | 文件持久化和输出扫描 |
| `suggestions/` | 5 | 补全建议（command/directory/shell history/skill） |
| `processUserInput/` | 4 | 用户输入处理（bash/slash/text prompt） |
| `todo/` | 1 | Todo 类型定义 |
| `ultraplan/` | 2 | Ultraplan（CCR session/keyword 检测） |
| `memory/` | 2 | 记忆类型和版本 |
| `skills/` | 1 | Skill 变更检测 |
| `background/` | 1 (remote子目录) | 后台远程任务 |

### 4.2 顶层关键文件

290 个顶层文件覆盖：认证(auth/aws/gcp)、API 通信(api/apiPreconnect)、配置(config/configConstants)、错误处理(errors)、日志(log/debug/diagLogs)、加密(crypto)、上下文(context/contextAnalysis)、光标(Cursor)、差异(diff)、格式化(format)、流(stream/CircularBuffer)、代理(proxy/mtls)、会话(sessionStorage/sessionState)、进程(process/cleanup/cleanupRegistry)、cron 调度(cron/cronScheduler/cronTasks)等。

---

## 五、Vim 模式状态机

### 5.1 完整状态图

`vim/types.ts` 定义了一个层次化的状态机，分为两级：

**顶级：VimState**
```
INSERT (记录 insertedText，用于 dot-repeat)
    ↕ (i/I/a/A/o/O 进入, Esc 退出)
NORMAL (嵌套 CommandState 子状态机)
```

**NORMAL 内部：CommandState（11 个状态）**

```
idle ──┬─[d/c/y]──► operator ──┬─[motion]──► execute
       ├─[1-9]────► count      ├─[0-9]────► operatorCount ──[motion]──► execute
       ├─[fFtT]───► find       ├─[ia]─────► operatorTextObj ──[wW"'(){}]──► execute
       ├─[g]──────► g          ├─[fFtT]───► operatorFind ──[char]──► execute
       ├─[r]──────► replace    └─[g]──────► operatorG ──[g/j/k]──► execute
       └─[><]─────► indent
```

### 5.2 持久状态与 Dot-Repeat

```typescript
export type PersistentState = {
  lastChange: RecordedChange | null  // 10 种变更类型
  lastFind: { type: FindType; char: string } | null
  register: string                    // yank 寄存器
  registerIsLinewise: boolean
}
```

`RecordedChange` 支持 10 种操作的精确回放：`insert`, `operator`, `operatorTextObj`, `operatorFind`, `replace`, `x`, `toggleCase`, `indent`, `openLine`, `join`。

### 5.3 Motion 与 Operator 分离

- **motions.ts**：纯函数，输入 `(key, cursor, count)` 输出新 `Cursor`。支持 `h/l/j/k`、`w/b/e/W/B/E`、`0/^/$`、`gj/gk`、`G`
- **operators.ts**：对 range 执行操作（delete/change/yank）。处理特殊情况如 `cw`（到词尾而非下一词首）
- **textObjects.ts**：`findTextObject()` 支持 `w/W`（词）、引号对（`"/'`）、括号对（`()/[]/{}/< >`）的 inner/around 范围
- **transitions.ts**：纯分发表，每个状态一个 transition 函数，返回 `{ next?, execute? }`

这种架构使得每一层都是纯函数，极易测试。

---

## 六、远程执行系统

### 6.1 CCR WebSocket 连接

`SessionsWebSocket.ts` 实现了到 Anthropic CCR 后端的 WebSocket 连接：

**协议**：
1. 连接 `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`
2. 通过 HTTP header 认证（`Authorization: Bearer <token>`）
3. 接收 `SDKMessage | SDKControlRequest | SDKControlResponse | SDKControlCancelRequest` 流

**重连策略**：
- 普通断开：最多 5 次重连，每次间隔 2 秒
- 4001 (session not found)：单独 3 次重试（compaction 期间可能暂时 404）
- 4003 (unauthorized)：永久关闭，不重连
- 30 秒 ping 间隔保持连接

**运行时兼容**：同时支持 Bun 原生 WebSocket 和 Node `ws` 包，代码分支处理两种 API。

### 6.2 SDK 消息适配器

`sdkMessageAdapter.ts` 桥接 CCR 发送的 SDK 格式消息和 REPL 内部消息类型。处理 10+ 种消息类型：

| SDK 消息类型 | 转换结果 | 说明 |
|-------------|---------|------|
| `assistant` | `AssistantMessage` | 模型回复 |
| `user` | `UserMessage` 或 ignored | 仅在 convertToolResults/convertUserTextMessages 时转换 |
| `stream_event` | `StreamEvent` | 流式部分消息 |
| `result` | `SystemMessage` (仅错误) | 会话结束信号 |
| `system` (init) | `SystemMessage` | 远程会话初始化 |
| `system` (status) | `SystemMessage` | compacting 等状态 |
| `system` (compact_boundary) | `SystemMessage` | 对话压缩边界 |
| `tool_progress` | `SystemMessage` | 工具执行进度 |
| `auth_status` | ignored | 认证状态 |
| `tool_use_summary` | ignored | SDK-only 事件 |
| `rate_limit_event` | ignored | SDK-only 事件 |

### 6.3 RemoteSessionManager

`RemoteSessionManager.ts` 协调三个通道：
- **WebSocket 订阅**：接收消息（通过 `SessionsWebSocket`）
- **HTTP POST**：发送用户消息（通过 `sendEventToRemoteSession()`）
- **权限请求/响应**：`pendingPermissionRequests` Map 管理挂起的 `can_use_tool` 请求

### 6.4 Direct Connect 自托管

`server/` 目录实现了一个轻量级自托管服务器模式：

- `createDirectConnectSession.ts`：POST `/sessions` 创建会话，返回 `{session_id, ws_url, work_dir}`
- `directConnectManager.ts`：`DirectConnectSessionManager` 类，通过 WebSocket 与自托管服务器通信
- `types.ts`：会话状态机 `starting -> running -> detached -> stopping -> stopped`，支持 `SessionIndex` 持久化到 `~/.claude/server-sessions.json`

与 CCR 模式的区别：Direct Connect 使用 NDJSON 格式通过 WebSocket 双向通信，消息格式是 `StdinMessage`/`StdoutMessage`；CCR 使用分离的 HTTP POST (发送) + WebSocket (接收) 通道。

---

## 七、键绑定系统

### 7.1 和弦（Chord）状态机

键绑定系统支持多键序列（chord），如 `ctrl+k ctrl+s`。核心在 `resolver.ts` 的 `resolveKeyWithChordState()`：

**状态转移**：

```
null (无 pending) ──[key]──►
  ├─ 匹配单键 binding ──► { type: 'match', action }
  ├─ 匹配多键 chord 前缀 ──► { type: 'chord_started', pending: [keystroke] }
  └─ 无匹配 ──► { type: 'none' }

pending: [ks1] ──[key]──►
  ├─ [ks1,ks2] 完全匹配 chord ──► { type: 'match', action }
  ├─ [ks1,ks2] 是更长 chord 前缀 ──► { type: 'chord_started', pending: [ks1,ks2] }
  ├─ Escape ──► { type: 'chord_cancelled' }
  └─ 无匹配 ──► { type: 'chord_cancelled' }
```

**关键设计**：chord 匹配优先于单键匹配——如果 `ctrl+k` 是某个 chord 的前缀，即使有单独的 `ctrl+k` binding，也进入 chord 等待状态。但如果更长的 chord 全部被 null-unbind 了，则回退到单键匹配。

### 7.2 上下文层次

18 个上下文覆盖所有 UI 状态：

```
Global > Chat > Autocomplete > Confirmation > Help > Transcript >
HistorySearch > Task > ThemePicker > Settings > Tabs > Attachments >
Footer > MessageSelector > DiffDialog > ModelPicker > Select > Plugin
```

每个上下文有独立的 binding 块。`resolveKey()` 接收 `activeContexts` 数组，按上下文过滤后 last-wins（用户覆盖优先）。

### 7.3 默认绑定摘要

`defaultBindings.ts` 定义了 17 个上下文块、约 100+ 个默认快捷键。平台适配：
- **图片粘贴**：Windows `alt+v`，其他 `ctrl+v`
- **模式切换**：Windows 无 VT mode 时 `meta+m`，其他 `shift+tab`
- **保留快捷键**：`ctrl+c` 和 `ctrl+d` 使用特殊双击时间窗口处理，不可重绑

---

## 八、Upstream Proxy 系统

### 8.1 CONNECT -> WebSocket 中继原理

`upstreamproxy/` 实现了 CCR 容器内的 HTTP CONNECT 代理，通过 WebSocket 隧道连接到上游代理服务器。

**架构**：

```
curl/gh/kubectl                   CCR 上游代理
    ↓ HTTP CONNECT                    ↓ MITM TLS
本地 TCP 中继 (127.0.0.1:ephemeral)  ↔ WebSocket ↔ GKE L7 Ingress
    relay.ts                          upstreamproxy.ts
```

**为什么用 WebSocket 而非原生 CONNECT**：CCR 入口是 GKE L7 路径前缀路由，没有 `connect_matcher`。WebSocket 复用了 session-ingress tunnel 已有的模式。

### 8.2 协议细节

1. **UpstreamProxyChunk protobuf**：手工编码（避免 protobufjs 依赖），单字段 `bytes data = 1`，tag = 0x0a + varint length + data
2. **认证分层**：WS upgrade 使用 `Bearer <session_token>`（ingress JWT）；tunnel 内 CONNECT 头使用 `Basic <sessionId:token>`（上游认证）
3. **Content-Type 关键**：必须设置 `application/proto`，否则服务端用 protojson 解析二进制 chunk 会静默失败
4. **安全措施**：`prctl(PR_SET_DUMPABLE, 0)` 通过 FFI 调用 libc，阻止同 UID 的 ptrace（防止 prompt injection 用 gdb 读取堆中的 token）

### 8.3 初始化流程

```
initUpstreamProxy()
  ├─ 读取 /run/ccr/session_token
  ├─ prctl(PR_SET_DUMPABLE, 0)
  ├─ 下载 CA 证书 (/v1/code/upstreamproxy/ca-cert) + 拼接系统 CA bundle
  ├─ 启动 TCP relay (Bun.listen 或 Node net.createServer)
  ├─ unlink token 文件（确保 relay 就绪后才删除）
  └─ 导出 HTTPS_PROXY / SSL_CERT_FILE / NODE_EXTRA_CA_CERTS / REQUESTS_CA_BUNDLE 环境变量
```

每一步 fail-open：任何错误只禁用代理，不阻断会话。

---

## 九、CLI / IO 系统

`cli/` 目录构建了 Claude Code 的 IO 层：

- **StructuredIO** (`structuredIO.ts`)：SDK 模式的结构化 IO。从 stdin 解析 `StdinMessage`（JSON 行），通过 `writeToStdout` 输出 `StdoutMessage`。处理 `control_request`/`control_response` 协议、权限请求、elicitation
- **RemoteIO** (`remoteIO.ts`)：继承 StructuredIO，添加 WebSocket/SSE transport 支持。通过 `CCRClient` 连接到 Anthropic 后端
- **transports/**：6 种传输实现——`ccrClient.ts`、`HybridTransport.ts`、`SSETransport.ts`、`WebSocketTransport.ts`、`SerialBatchEventUploader.ts`、`WorkerStateUploader.ts`
- **handlers/**：6 个处理器——`agents.ts`、`auth.ts`、`autoMode.ts`、`mcp.tsx`、`plugins.ts`、`util.tsx`

---

## 十、Memdir 记忆系统

### 10.1 架构设计

memdir 是 Claude Code 的持久化记忆系统，基于文件系统实现：

- **目录结构**：`~/.claude/projects/<sanitized-cwd>/memory/`
- **入口文件**：`MEMORY.md`（索引，限 200 行 / 25KB）
- **记忆文件**：独立 `.md` 文件，带 frontmatter（name/description/type）
- **团队目录**：`memory/team/`（共享记忆，需 GrowthBook gate）
- **日志模式**：`memory/logs/YYYY/MM/YYYY-MM-DD.md`（Kairos 助手模式）

### 10.2 四种记忆类型

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
```

- **user**：用户角色、偏好、知识背景（始终 private）
- **feedback**：用户纠正和确认（默认 private，项目级公约时可 team）
- **project**：项目上下文、截止日期、决策（偏向 team）
- **reference**：外部系统指针（通常 team）

### 10.3 智能召回

`findRelevantMemories.ts` 使用 Sonnet 侧查询从记忆库中选择相关记忆（最多 5 个）：
1. `scanMemoryFiles()` 扫描目录，读取 frontmatter 头
2. `selectRelevantMemories()` 将清单 + 用户查询发给 Sonnet，使用 JSON schema 输出
3. 返回相关文件路径 + mtime（用于新鲜度标注）

### 10.4 路径安全

`teamMemPaths.ts` 实现了多层防御：
- `sanitizePathKey()`：拒绝 null byte、URL 编码遍历、Unicode NFKC 归一化攻击、反斜杠、绝对路径
- `validateTeamMemWritePath()`：两遍检查——`path.resolve()` 字符串级 + `realpathDeepestExisting()` 符号链接解析
- `isRealPathWithinTeamDir()`：要求 realpath 前缀匹配 + 分隔符保护（防 `/foo/team-evil` 匹配 `/foo/team`）
- 悬空符号链接检测：`lstat()` 区分真不存在 vs 符号链接目标缺失

---

## 十一、模块间依赖拓扑

```
                       ┌──────────────┐
                       │  state/store │ (35行核心)
                       └──────┬───────┘
                              │ onChange
                    ┌─────────▼──────────┐
                    │ onChangeAppState   │ (副作用中心)
                    └──┬──────┬──────┬───┘
                       │      │      │
              ┌────────▼┐ ┌──▼───┐ ┌▼────────┐
              │settings  │ │CCR   │ │config   │
              │persist   │ │sync  │ │persist  │
              └──────────┘ └──────┘ └─────────┘

   tasks/ ◄──── Task.ts ◄──── tasks.ts (注册表)
     │              │
     │         ┌────▼────┐
     └────────►│AppState │◄──── remote/ (CCR/DirectConnect)
               │ .tasks  │
               └─────────┘
                    │
            ┌───────▼────────┐
            │ keybindings/   │ (上下文感知输入分发)
            │ resolver.ts    │
            └────────────────┘
                    │
            ┌───────▼────────┐
            │ cli/ (IO层)    │
            │ StructuredIO   │◄──── upstreamproxy/ (CONNECT relay)
            │ RemoteIO       │
            └────────────────┘
                    │
            ┌───────▼────────┐
            │ vim/ (编辑器)   │◄──── utils/Cursor.ts
            │ transitions.ts │
            └────────────────┘
```

---

## 总结

Claude Code 的基础设施模块展现了几个一致的设计原则：

1. **极简核心 + 外部扩展**：35 行 Store、纯函数 vim transitions、声明式 keybinding 配置
2. **安全纵深防御**：memdir 的 4 层路径校验、upstreamproxy 的 prctl + token 生命周期管理、symlink 安全的 task ID
3. **失败开放(fail-open)**：upstream proxy 每一步出错只禁用功能不阻断会话；迁移脚本幂等设计
4. **运行时兼容**：WebSocket 同时支持 Bun/Node；feature gate 按需加载任务类型
5. **集中式副作用管理**：`onChangeAppState` 作为唯一的状态变更副作用处理点，替代分散的 8+ 通知路径
