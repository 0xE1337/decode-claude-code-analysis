# 03 - 工具系统深度架构分析

## 1. Tool 类型系统深度解剖

### 1.1 泛型参数 `Input`, `Output`, `P` 的精确含义

`Tool.ts` (792行) 定义了核心泛型类型：

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,   // Zod schema，约束为对象类型
  Output = unknown,                       // 工具输出的数据类型
  P extends ToolProgressData = ToolProgressData, // 进度报告的类型
> = { ... }
```

- **`Input extends AnyObject`** — 必须是 `z.ZodType<{ [key: string]: unknown }>`，即 Zod schema 且输出必须为对象。这保证了所有工具输入都是 JSON 对象，与 Claude API 的 `tool_use` block 的 `input: Record<string, unknown>` 对齐。通过 `z.infer<Input>` 在编译时推导出具体参数类型。
- **`Output`** — 无约束。各工具自由定义，BashTool 的 `Out` 含 `stdout/stderr/interrupted/isImage` 等丰富字段，而 MCPTool 仅 `string`。Output 在 `ToolResult<T>` 中被包裹，额外携带 `newMessages` 和 `contextModifier`。
- **`P extends ToolProgressData`** — 约束进度事件类型。BashTool 用 `BashProgress`（含 `output/totalLines/totalBytes`），AgentTool 用 `AgentToolProgress | ShellProgress` 联合类型，让 SDK 侧能接收子 agent 的 shell 执行进度。

### 1.2 buildTool 的 fail-closed 默认值策略

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // 假设并发不安全
  isReadOnly: (_input?: unknown) => false,           // 假设会写入
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (...) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',   // 跳过分类器
  userFacingName: (_input?: unknown) => '',
}
```

**安全设计哲学：fail-closed（默认关闭）**

| 默认值 | 安全意义 |
|--------|----------|
| `isConcurrencySafe → false` | 未声明安全的工具串行执行，避免竞态条件 |
| `isReadOnly → false` | 未声明只读的工具需要经过完整权限检查链 |
| `toAutoClassifierInput → ''` | 跳过安全分类器 = 不会被自动批准，需要人工审批 |

`buildTool` 使用 TypeScript 类型体操确保默认值正确覆盖：

```typescript
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K] ? ToolDefaults[K] : D[K]
    : ToolDefaults[K]
}
```

这段类型意味着：如果工具定义 D 提供了某个 key 且不是 `undefined`，用 D 的类型；否则用默认值的类型。`-?` 去除可选标记，确保输出类型中所有方法都是必须的。

### 1.3 ToolUseContext 完整字段分析

`ToolUseContext` 是工具执行的完整运行时上下文，约 50+ 个字段，分为以下逻辑组：

**核心配置组**：
- `options.tools` — 当前可用工具列表
- `options.mainLoopModel` — 主循环模型名称
- `options.mcpClients` — MCP 服务器连接列表
- `options.thinkingConfig` — 思考配置
- `abortController` — 中止信号控制器

**状态管理组**：
- `getAppState()` / `setAppState()` — 全局应用状态的读写
- `setAppStateForTasks?` — 始终指向根 AppState 的写入器，即使在嵌套 async agent 中也不会是 no-op。专为 session 级基础设施（后台任务、hooks）设计
- `readFileState` — 文件读取缓存（LRU），追踪文件内容和修改时间
- `messages` — 当前对话历史

**权限与追踪组**：
- `toolDecisions` — 工具调用的权限决策缓存
- `localDenialTracking?` — 异步子 agent 的本地拒绝计数器
- `contentReplacementState?` — 工具结果预算的内容替换状态

**UI 交互组**：
- `setToolJSX?` — 设置工具执行期间的实时 JSX 渲染
- `setStreamMode?` — 控制 spinner 显示模式
- `requestPrompt?` — 请求用户交互式输入的回调工厂

**缓存共享组（Fork Agent 专用）**：
- `renderedSystemPrompt?` — 父级已渲染的系统提示字节，Fork 子 agent 直接复用以保持 prompt cache 一致

---

## 2. BashTool 完整解剖（18 个文件）

### 2.1 文件清单与职责

| 文件 | 职责 | 行数(估) |
|------|------|---------|
| `BashTool.tsx` | 主入口：schema定义、call执行、结果处理 | 800+ |
| `bashPermissions.ts` | 权限检查：规则匹配、子命令分析、安全变量处理 | 700+ |
| `bashSecurity.ts` | 安全验证：23种注入攻击模式检测 | 800+ |
| `shouldUseSandbox.ts` | 沙箱决策：是否在沙箱中执行命令 | 154 |
| `commandSemantics.ts` | 退出码语义解释（grep返回1不是错误） | ~100 |
| `readOnlyValidation.ts` | 只读验证：判断命令是否为纯读操作 | 200+ |
| `bashCommandHelpers.ts` | 复合命令操作符权限检查 | ~150 |
| `pathValidation.ts` | 路径约束检查：命令是否访问了允许范围外的路径 | 200+ |
| `sedEditParser.ts` | sed命令解析器：提取文件路径和替换模式 | ~200 |
| `sedValidation.ts` | sed安全验证：确保sed编辑在允许范围内 | ~150 |
| `modeValidation.ts` | 模式验证：plan模式下的命令约束 | ~100 |
| `destructiveCommandWarning.ts` | 破坏性命令警告生成 | ~50 |
| `commentLabel.ts` | 命令注释标签提取 | ~30 |
| `prompt.ts` | Bash工具的system prompt和超时配置 | ~100 |
| `toolName.ts` | 工具名称常量 | ~5 |
| `utils.ts` | 辅助函数：图片处理、CWD重置、空行清理 | ~150 |
| `UI.tsx` | React渲染：命令输入/输出/进度/错误 | 300+ |
| `BashToolResultMessage.tsx` | 结果消息的React组件 | ~100 |

### 2.2 命令执行的完整生命周期

```
用户请求 "ls -la"
      │
      ▼
┌─────────────────────┐
│ 1. Schema 验证       │  inputSchema().safeParse(input)
│    解析 command,      │  包含 timeout, description,
│    timeout 等         │  run_in_background, dangerouslyDisableSandbox
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 2. validateInput()   │  - detectBlockedSleepPattern(): 阻止 sleep>2s
│    输入层验证         │    建议使用 Monitor 工具
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 3. bashSecurity.ts   │  - extractQuotedContent(): 剥离引号内容
│    AST 安全检查       │  - 23种检查（见下方表格）
│                      │  - parseForSecurity(): tree-sitter AST解析
│                      │  - Zsh危险命令检测 (zmodload, sysopen等)
│                      │  - 命令替换模式检测 ($(), ``, <()等)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 4. bashPermissions   │  - splitCommand → 拆分复合命令
│    权限检查链        │  - 逐子命令匹配 allow/deny/ask 规则
│                      │  - stripSafeWrappers(): 去除 timeout/env 包装
│                      │  - bashClassifier 分类器（可选）
│                      │  - checkPathConstraints(): 路径边界检查
│                      │  - checkSedConstraints(): sed 编辑检查
│                      │  - checkPermissionMode(): plan 模式检查
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 5. shouldUseSandbox  │  - SandboxManager.isSandboxingEnabled()
│    沙箱决策          │  - dangerouslyDisableSandbox + 策略检查
│                      │  - containsExcludedCommand(): 用户配置排除
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 6. exec() 实际执行   │  - runShellCommand(): AsyncGenerator
│    Shell 执行        │  - 周期性 yield 进度事件
│                      │  - 超时控制 (默认120s, 最大600s)
│                      │  - 后台任务支持 (run_in_background)
│                      │  - 助手模式自动后台化 (15s 阈值)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 7. 结果处理          │  - interpretCommandResult(): 语义退出码
│                      │  - trackGitOperations(): git操作追踪
│                      │  - SandboxManager.annotateStderrWithSandboxFailures()
│                      │  - 大输出持久化 (>30K字符 → 磁盘文件)
│                      │  - 图片输出检测与调整大小
└─────────────────────┘
```

### 2.3 bashSecurity.ts 的 23 种安全检查

```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,          // 不完整命令（缺少闭合引号等）
  JQ_SYSTEM_FUNCTION: 2,          // jq的system()函数调用
  JQ_FILE_ARGUMENTS: 3,           // jq的文件参数注入
  OBFUSCATED_FLAGS: 4,            // 混淆的命令行标志
  SHELL_METACHARACTERS: 5,        // Shell元字符注入
  DANGEROUS_VARIABLES: 6,         // 危险的环境变量
  NEWLINES: 7,                    // 命令中的换行符注入
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,  // $()命令替换
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,     // 输入重定向
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,   // 输出重定向
  IFS_INJECTION: 11,              // IFS字段分隔符注入
  GIT_COMMIT_SUBSTITUTION: 12,    // git commit消息中的替换
  PROC_ENVIRON_ACCESS: 13,        // /proc/self/environ 访问
  MALFORMED_TOKEN_INJECTION: 14,  // 畸形token注入
  BACKSLASH_ESCAPED_WHITESPACE: 15, // 反斜杠转义的空白字符
  BRACE_EXPANSION: 16,            // 花括号扩展
  CONTROL_CHARACTERS: 17,         // 控制字符
  UNICODE_WHITESPACE: 18,         // Unicode空白字符
  MID_WORD_HASH: 19,              // 单词中间的#号
  ZSH_DANGEROUS_COMMANDS: 20,     // Zsh危险命令
  BACKSLASH_ESCAPED_OPERATORS: 21, // 反斜杠转义的操作符
  COMMENT_QUOTE_DESYNC: 22,       // 注释/引号不同步
  QUOTED_NEWLINE: 23,             // 引号内的换行符
}
```

Zsh 特有的危险命令集（20 个）：`zmodload`（模块加载网关）、`emulate`（eval等效）、`sysopen/sysread/syswrite`（文件描述符操作）、`zpty`（伪终端执行）、`ztcp/zsocket`（网络外泄）、`zf_rm/zf_mv` 等（绕过二进制检查的内建命令）。

### 2.4 命令语义系统

`commandSemantics.ts` 实现了命令退出码的语义解释，避免将正常行为误报为错误：

- `grep` 返回码 1 → "No matches found"（不是错误）
- `diff` 返回码 1 → "Files differ"（正常功能）
- `test/[` 返回码 1 → "Condition is false"
- `find` 返回码 1 → "Some directories were inaccessible"（部分成功）

---

## 3. AgentTool 完整解剖

### 3.1 内置 Agent 类型

| Agent 类型 | 职责 | 工具限制 | 模型 | 特殊标记 |
|-----------|------|---------|------|---------|
| `general-purpose` | 通用任务执行 | `['*']` 全部工具 | 默认子agent模型 | 无 |
| `Explore` | 只读代码探索 | 禁止 Agent/Edit/Write/Notebook | ant: inherit; 外部: haiku | `omitClaudeMd`, one-shot |
| `Plan` | 架构设计规划 | 同 Explore | inherit | `omitClaudeMd`, one-shot |
| `verification` | 实现验证（试图打破它） | 禁止 Agent/Edit/Write/Notebook | inherit | `background: true`, 红色标记 |
| `claude-code-guide` | Claude Code 使用指南 | — | — | 仅非SDK入口 |
| `statusline-setup` | 状态栏设置 | — | — | — |
| `fork` (实验性) | 继承父级完整上下文 | `['*']` + `useExactTools` | inherit | `permissionMode: 'bubble'` |

### 3.2 Agent 模式分类与触发

**1. 同步前台 Agent（默认）**：直接在主线程等待完成，消费 AsyncGenerator 中的每条消息。

**2. 异步后台 Agent**：`run_in_background: true` 或 `autoBackgroundMs` 超时后触发。注册到 `LocalAgentTask`，通过 `<task-notification>` 通知完成。

**3. Fork Agent（实验性）**：当 `FORK_SUBAGENT` feature flag 开启且未指定 `subagent_type` 时触发。子 agent 继承父级的完整对话上下文和系统提示。

**4. 远程 Agent（ant-only）**：`isolation: 'remote'` 触发，在远程 CCR 环境中启动。

**5. Worktree Agent**：`isolation: 'worktree'` 创建 git worktree 隔离副本。

**6. Teammate Agent（agent swarms）**：通过 `spawnTeammate()` 创建，运行在独立的 tmux 窗格中。

### 3.3 runAgent() 的 AsyncGenerator 实现

```typescript
export async function* runAgent({
  agentDefinition, promptMessages, toolUseContext, canUseTool,
  isAsync, forkContextMessages, querySource, override, model,
  maxTurns, availableTools, allowedTools, onCacheSafeParams,
  contentReplacementState, useExactTools, worktreePath, ...
}): AsyncGenerator<Message, void> {
```

核心流程：
1. **创建 agent 上下文**：`createSubagentContext()` 从父级克隆 readFileState、contentReplacementState
2. **初始化 MCP 服务器**：`initializeAgentMcpServers()` 连接 agent 定义中的 MCP servers
3. **构建系统提示**：`buildEffectiveSystemPrompt()` + `enhanceSystemPromptWithEnvDetails()`
4. **消息循环**：调用 `query()` 获取 stream events，过滤并 yield 可记录的消息
5. **Transcript 记录**：`recordSidechainTranscript()` 将每条消息写入会话存储
6. **清理**：`cleanupAgentTracking()`、MCP cleanup、Perfetto unregister

关键设计：`runAgent` 返回 `AsyncGenerator<Message, void>`，让调用者（AgentTool.call）能逐条消费消息并实时发送进度事件给 SDK。

### 3.4 Fork Agent 的 Prompt Cache 共享机制

Fork Agent 的核心目标是**所有 fork 子 agent 共享父级的 prompt cache**。实现要点：

1. **`renderedSystemPrompt`**：父级在 turn 开始时冻结已渲染的系统提示字节，通过 `toolUseContext.renderedSystemPrompt` 传递给 fork 子 agent。**不重新调用 `getSystemPrompt()`**，因为 GrowthBook 状态可能在冷→热之间变化（cold→warm divergence），导致字节不同、cache 失效。

2. **`buildForkedMessages()`**：构建 fork 对话消息时：
   - 保留完整的父级 assistant 消息（所有 tool_use blocks、thinking、text）
   - 所有 `tool_result` blocks 替换为统一的占位符 `"Fork started — processing in background"`
   - 这确保不同 fork 子 agent 的 API 请求前缀**字节完全相同**

3. **`useExactTools: true`**：fork 路径跳过 `resolveAgentTools()` 过滤，直接使用父级的工具池，确保工具定义在 API 请求中的顺序和内容完全一致。

```typescript
export const FORK_AGENT = {
  tools: ['*'],           // 继承父级全部工具
  model: 'inherit',       // 继承父级模型
  permissionMode: 'bubble', // 权限提示冒泡到父终端
  getSystemPrompt: () => '', // 未使用——通过 override.systemPrompt 传递
}
```

---

## 4. ToolSearch 延迟加载机制

### 4.1 shouldDefer 和 alwaysLoad 的决策逻辑

```typescript
export function isDeferredTool(tool: Tool): boolean {
  // 1. alwaysLoad: true → 永不延迟（MCP 工具可通过 _meta['anthropic/alwaysLoad'] 设置）
  if (tool.alwaysLoad === true) return false

  // 2. MCP 工具一律延迟
  if (tool.isMcp === true) return true

  // 3. ToolSearch 自身永不延迟
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // 4. Fork 模式下 Agent 工具不延迟（turn 1 就需要）
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    if (isForkSubagentEnabled()) return false
  }

  // 5. Brief 工具（Kairos 通信通道）不延迟
  // 6. SendUserFile 工具不延迟

  // 7. 其他工具按 shouldDefer 标记决定
  return tool.shouldDefer === true
}
```

### 4.2 延迟加载的工具类别

| 类别 | 示例 | 原因 |
|------|------|------|
| 所有 MCP 工具 | `mcp__slack__*`, `mcp__github__*` | 工作流特定，大多数会话不需要 |
| 声明 `shouldDefer: true` 的内置工具 | NotebookEdit, WebFetch, WebSearch, EnterWorktree, ExitWorktree | 使用频率较低 |

**不延迟的关键工具**：Bash, FileRead, FileEdit, FileWrite, Glob, Grep, Agent, ToolSearch, SkillTool, Brief（Kairos模式下）

### 4.3 搜索匹配算法

ToolSearchTool 使用**多信号加权评分**：

```
精确部分匹配(MCP): +12分  |  精确部分匹配(普通): +10分
部分包含匹配(MCP): +6分   |  部分包含匹配(普通): +5分
searchHint 匹配: +4分     |  全名回退匹配: +3分
描述词边界匹配: +2分
```

支持 `select:` 前缀精确选择和 `+` 前缀必须包含语法。返回 `tool_reference` 类型的内容块，API 服务端据此解压完整的工具 schema 定义。

---

## 5. MCP 工具统一适配

### 5.1 MCPTool 模板模式

`MCPTool.ts` 定义了一个**模板对象**，在 `client.ts` 中被 `{ ...MCPTool, ...overrides }` 展开覆盖：

```typescript
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // 被覆盖为 mcp__server__tool
  maxResultSizeChars: 100_000,
  async description() { return DESCRIPTION },  // 被覆盖
  async prompt() { return PROMPT },            // 被覆盖
  async call() { return { data: '' } },        // 被覆盖为实际 MCP 调用
  async checkPermissions() {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
  // inputSchema 使用 z.object({}).passthrough() 接受任意输入
})
```

### 5.2 client.ts 中的适配逻辑

MCP 服务端每个 tool 在客户端被创建为独立的 Tool 对象：

```typescript
{
  ...MCPTool,
  name: skipPrefix ? tool.name : fullyQualifiedName,  // mcp__server__tool
  mcpInfo: { serverName: client.name, toolName: tool.name },
  isConcurrencySafe() { return tool.annotations?.readOnlyHint ?? false },
  isReadOnly() { return tool.annotations?.readOnlyHint ?? false },
  isDestructive() { return tool.annotations?.destructiveHint ?? false },
  isOpenWorld() { return tool.annotations?.openWorldHint ?? false },
  alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
  searchHint: tool._meta?.['anthropic/searchHint'],
  inputJSONSchema: tool.inputSchema,  // 直接使用 JSON Schema，不转 Zod
  async call(args, context, _canUseTool, parentMessage, onProgress) {
    // 实际调用 MCP 客户端的 callTool 方法
  }
}
```

关键设计：
- `inputJSONSchema` 字段允许 MCP 工具直接提供 JSON Schema 而非 Zod schema
- MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) 被映射到内部 Tool 接口方法
- `checkPermissions` 返回 `passthrough`，表示需要通用权限系统处理

---

## 6. 工具并发安全

### 6.1 分区执行策略

`toolOrchestration.ts` 实现了基于 `isConcurrencySafe` 的**分区执行**：

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc, toolUse) => {
    const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data)
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)  // 合并到上一个并发批次
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // 新批次
    }
    return acc
  }, [])
}
```

执行逻辑：
- **并发安全批次**：`runToolsConcurrently()` 并行执行，并发上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`（默认 10）。contextModifier 在批次结束后顺序应用。
- **非并发安全批次**：`runToolsSerially()` 串行执行，每个工具的 contextModifier 立即应用。

### 6.2 各工具的并发安全声明

| 工具 | isConcurrencySafe | 原因 |
|------|-------------------|------|
| BashTool | `this.isReadOnly(input)` | 只有只读命令才并发安全 |
| FileReadTool | `true` | 纯读操作 |
| GlobTool | `true` | 纯搜索 |
| GrepTool | `true` | 纯搜索 |
| WebSearchTool | `true` | 无状态外部查询 |
| AgentTool | `true` | 子 agent 有独立上下文 |
| FileEditTool | `false`（默认） | 文件写入需串行 |
| FileWriteTool | `false`（默认） | 文件写入需串行 |
| SkillTool | `false`（默认） | 可能有副作用 |
| MCPTool | `readOnlyHint ?? false` | 遵循 MCP annotations |
| ToolSearchTool | `true` | 纯查询 |

### 6.3 StreamingToolExecutor 的流式并发

`StreamingToolExecutor.ts` 在流式场景中实现更细粒度的并发控制：

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

规则：只有当队列中**所有正在执行的工具都是并发安全的**，且新工具也是并发安全的，才允许并行启动。

---

## 7. 工具结果持久化

### 7.1 maxResultSizeChars 分层体系

```
                    系统级上限 (DEFAULT_MAX_RESULT_SIZE_CHARS = 50K)
                                    │
                         ┌──────────┼──────────┐
                         │          │          │
                    BashTool      GrepTool   大多数工具
                    30K chars     20K chars   100K chars
                         │                     │
                    Math.min(声明值, 50K)  Math.min(声明值, 50K)
                    = 30K                 = 50K
```

**特殊情况**：
- `FileReadTool.maxResultSizeChars = Infinity` — 永不持久化，因为持久化后模型需要用 Read 读取文件，形成循环读取（Read → file → Read）
- `McpAuthTool.maxResultSizeChars = 10_000` — 最小的阈值，认证信息应尽量精简

### 7.2 超限处理流程

```typescript
// toolResultStorage.ts
export async function persistToolResult(content, toolUseId) {
  await ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, isJson)
  await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES)
  return { filepath, originalSize, isJson, preview, hasMore }
}
```

超限后，模型收到：
```xml
<persisted-output>
Output too large (45.2 KB). Full output saved to: /path/to/tool-results/abc123.txt

Preview (first 2.0 KB):
[前2000字节的预览内容]
...
</persisted-output>
```

### 7.3 聚合预算控制

`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` 限制单条用户消息中所有并行 tool_result 的总大小。当 N 个并行工具各产出接近阈值的结果时，**最大的块被优先持久化**到满足预算。

---

## 8. 完整工具清单

### 8.1 核心内置工具

| 工具名称 | 类型 | 并发安全 | 最大结果 | 延迟加载 | 说明 |
|---------|------|---------|---------|---------|------|
| Agent | 子agent | true | 100K | 否* | 子agent创建与管理 |
| Bash | Shell | 条件 | 30K | 否 | 命令执行（最复杂） |
| FileRead (Read) | 文件 | true | Infinity | 否 | 文件读取 |
| FileEdit (Edit) | 文件 | false | 100K | 否 | 文件编辑 |
| FileWrite (Write) | 文件 | false | 100K | 否 | 文件写入 |
| Glob | 搜索 | true | 100K | 否 | 文件模式匹配 |
| Grep | 搜索 | true | 20K | 否 | 内容搜索 |
| WebSearch | 网络 | true | 100K | 是 | 网页搜索 |
| WebFetch | 网络 | false | 100K | 是 | 网页抓取 |
| ToolSearch | 元工具 | true | 100K | 否 | 工具发现 |
| Skill | 技能 | false | 100K | 否 | Skill调用 |
| NotebookEdit | 文件 | false | 100K | 是 | Jupyter编辑 |
| TodoWrite | 状态 | false | 100K | 否 | Todo管理 |
| AskUserQuestion | 交互 | false | — | 否 | 用户提问 |
| TaskStop | 控制 | false | 100K | 否 | 停止任务 |
| TaskOutput | 控制 | true | 100K | 否 | 任务输出 |
| Brief | 通信 | true | 100K | 否** | 简洁消息（Kairos） |
| SendMessage | 通信 | false | 100K | 否 | 发送消息（swarms） |
| EnterPlanMode | 模式 | true | 100K | 否 | 进入计划模式 |
| ExitPlanModeV2 | 模式 | false | — | 否 | 退出计划模式 |

*Fork模式下不延迟  **Kairos模式下不延迟

### 8.2 条件加载工具

| 工具名称 | 条件 | 说明 |
|---------|------|------|
| REPLTool | `USER_TYPE === 'ant'` | VM沙箱包装器（Bash/Read/Edit在VM内执行） |
| ConfigTool | `USER_TYPE === 'ant'` | 配置管理 |
| TungstenTool | `USER_TYPE === 'ant'` | Tungsten集成 |
| PowerShellTool | `isPowerShellToolEnabled()` | Windows PowerShell |
| WebBrowserTool | `feature('WEB_BROWSER_TOOL')` | 浏览器自动化 |
| SleepTool | `feature('PROACTIVE')` 或 `feature('KAIROS')` | 延时等待 |
| MonitorTool | `feature('MONITOR_TOOL')` | 事件监控 |
| CronCreate/Delete/List | `feature('AGENT_TRIGGERS')` | 定时任务管理 |
| TeamCreate/TeamDelete | `isAgentSwarmsEnabled()` | Agent群组管理 |
| TaskCreate/Get/Update/List | `isTodoV2Enabled()` | 任务管理v2 |
| EnterWorktree/ExitWorktree | `isWorktreeModeEnabled()` | Git worktree隔离 |
| SnipTool | `feature('HISTORY_SNIP')` | 历史裁剪 |
| ListPeersTool | `feature('UDS_INBOX')` | 对等节点列表 |
| WorkflowTool | `feature('WORKFLOW_SCRIPTS')` | 工作流脚本 |
| LSPTool | `ENABLE_LSP_TOOL` | 语言服务器协议 |
| VerifyPlanExecutionTool | `CLAUDE_CODE_VERIFY_PLAN` | 计划验证 |

---

## 9. 设计权衡与洞察

### 9.1 结构化类型 vs 传统继承

Claude Code 选择了 `Tool` 类型 + `buildTool` 工厂，而非 `abstract class Tool`。这使得：
- MCP 工具可以通过 `{ ...MCPTool, ...overrides }` 轻松适配
- 每个工具是一个扁平对象，没有原型链开销
- TypeScript 的 `satisfies ToolDef<...>` 在编译时验证类型正确性

### 9.2 安全性的纵深防御

BashTool 展示了典型的**纵深防御**（defense in depth）：
1. **语法层**：AST 解析 + 23 种注入模式检测
2. **权限层**：规则匹配 + 分类器 + 路径约束
3. **运行时层**：沙箱隔离 + 超时控制
4. **输出层**：sandbox violation 标注 + 大输出裁剪

每一层都假设其他层可能被绕过，独立提供安全保障。

### 9.3 Prompt Cache 共享的精巧设计

Fork Agent 的缓存共享机制体现了对 API 成本的极致优化：
- 冻结系统提示字节（避免 GrowthBook 状态漂移）
- 统一占位符替换 tool_result（确保前缀字节相同）
- `useExactTools` 保持工具定义顺序一致
- 代价是 fork 子 agent 无法独立修改系统提示或工具集

### 9.4 Dead Code Elimination 驱动的模块设计

`tools.ts` 大量使用 `feature()` + `require()` 的条件导入模式：
```typescript
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool : null
```

Bun 的打包器能在编译时将 `feature('X')` 求值为常量，未激活的工具代码被完全移除。这也解释了为什么 `bashPermissions.ts` 头部有关于 "DCE cliff" 的注释——函数复杂度预算限制了 Bun 进行常量传播的能力。

### 9.5 工具结果的三级预算

1. **工具级** `maxResultSizeChars`：每个工具的声明值（20K~100K）
2. **系统级** `DEFAULT_MAX_RESULT_SIZE_CHARS`（50K）：硬上限，`Math.min` 裁剪
3. **消息级** `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`（200K）：单消息内所有并行结果的聚合预算
4. **GrowthBook 覆盖** `tengu_satin_quoll`：远程动态调整特定工具的阈值

这种分层确保了在各种场景下（单工具大输出、N个并行工具、特殊需求远程调优）上下文窗口不会被工具结果耗尽。
