# 03 - Tool System In-Depth Architecture Analysis

## 1. Deep Dive into the Tool Type System

### 1.1 Precise Meanings of Generic Parameters `Input`, `Output`, `P`

`Tool.ts` (792 lines) defines the core generic types:

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,   // Zod schema, constrained to object types
  Output = unknown,                       // Data type of tool output
  P extends ToolProgressData = ToolProgressData, // Type for progress reporting
> = { ... }
```

- **`Input extends AnyObject`** — Must be `z.ZodType<{ [key: string]: unknown }>`, i.e., a Zod schema whose output must be an object. This guarantees all tool inputs are JSON objects, aligned with the Claude API's `tool_use` block `input: Record<string, unknown>`. Concrete parameter types are inferred at compile time via `z.infer<Input>`.
- **`Output`** — Unconstrained. Each tool defines it freely. BashTool's `Out` contains rich fields like `stdout/stderr/interrupted/isImage`, while MCPTool uses only `string`. Output is wrapped in `ToolResult<T>`, which additionally carries `newMessages` and `contextModifier`.
- **`P extends ToolProgressData`** — Constrains the progress event type. BashTool uses `BashProgress` (containing `output/totalLines/totalBytes`), AgentTool uses the union type `AgentToolProgress | ShellProgress`, enabling the SDK side to receive shell execution progress from sub-agents.

### 1.2 buildTool's Fail-Closed Default Value Strategy

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // Assume not concurrency-safe
  isReadOnly: (_input?: unknown) => false,           // Assume writes
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (...) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',   // Skip classifier
  userFacingName: (_input?: unknown) => '',
}
```

**Security Design Philosophy: Fail-Closed (Deny by Default)**

| Default Value | Security Implication |
|---------------|---------------------|
| `isConcurrencySafe → false` | Tools not declared safe execute serially, avoiding race conditions |
| `isReadOnly → false` | Tools not declared read-only go through the full permission check chain |
| `toAutoClassifierInput → ''` | Skipping the safety classifier = won't be auto-approved, requires manual review |

`buildTool` uses TypeScript type gymnastics to ensure defaults are correctly applied:

```typescript
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K] ? ToolDefaults[K] : D[K]
    : ToolDefaults[K]
}
```

This type means: if the tool definition D provides a key that is not `undefined`, use D's type; otherwise use the default value's type. The `-?` removes the optional modifier, ensuring all methods in the output type are required.

### 1.3 Complete Field Analysis of ToolUseContext

`ToolUseContext` is the complete runtime context for tool execution, with approximately 50+ fields organized into the following logical groups:

**Core Configuration Group**:
- `options.tools` — List of currently available tools
- `options.mainLoopModel` — Main loop model name
- `options.mcpClients` — MCP server connection list
- `options.thinkingConfig` — Thinking configuration
- `abortController` — Abort signal controller

**State Management Group**:
- `getAppState()` / `setAppState()` — Read/write global application state
- `setAppStateForTasks?` — Writer that always points to the root AppState, never a no-op even in nested async agents. Designed for session-level infrastructure (background tasks, hooks)
- `readFileState` — File read cache (LRU), tracking file contents and modification times
- `messages` — Current conversation history

**Permissions and Tracking Group**:
- `toolDecisions` — Permission decision cache for tool calls
- `localDenialTracking?` — Local denial counter for async sub-agents
- `contentReplacementState?` — Content replacement state for tool result budgets

**UI Interaction Group**:
- `setToolJSX?` — Sets live JSX rendering during tool execution
- `setStreamMode?` — Controls spinner display mode
- `requestPrompt?` — Callback factory for requesting interactive user input

**Cache Sharing Group (Fork Agent Only)**:
- `renderedSystemPrompt?` — Parent's rendered system prompt bytes, reused directly by Fork sub-agents to maintain prompt cache consistency

---

## 2. Complete Anatomy of BashTool (18 Files)

### 2.1 File Inventory and Responsibilities

| File | Responsibility | Lines (est.) |
|------|---------------|-------------|
| `BashTool.tsx` | Main entry: schema definition, call execution, result handling | 800+ |
| `bashPermissions.ts` | Permission checks: rule matching, subcommand analysis, safe variable handling | 700+ |
| `bashSecurity.ts` | Security validation: detection of 23 injection attack patterns | 800+ |
| `shouldUseSandbox.ts` | Sandbox decision: whether to execute commands in a sandbox | 154 |
| `commandSemantics.ts` | Exit code semantic interpretation (grep returning 1 is not an error) | ~100 |
| `readOnlyValidation.ts` | Read-only validation: determining if a command is purely a read operation | 200+ |
| `bashCommandHelpers.ts` | Compound command operator permission checks | ~150 |
| `pathValidation.ts` | Path constraint checks: whether a command accesses paths outside the allowed scope | 200+ |
| `sedEditParser.ts` | sed command parser: extracting file paths and replacement patterns | ~200 |
| `sedValidation.ts` | sed safety validation: ensuring sed edits are within allowed scope | ~150 |
| `modeValidation.ts` | Mode validation: command constraints in plan mode | ~100 |
| `destructiveCommandWarning.ts` | Destructive command warning generation | ~50 |
| `commentLabel.ts` | Command comment label extraction | ~30 |
| `prompt.ts` | Bash tool's system prompt and timeout configuration | ~100 |
| `toolName.ts` | Tool name constants | ~5 |
| `utils.ts` | Utility functions: image processing, CWD reset, empty line cleanup | ~150 |
| `UI.tsx` | React rendering: command input/output/progress/errors | 300+ |
| `BashToolResultMessage.tsx` | React component for result messages | ~100 |

### 2.2 Complete Lifecycle of Command Execution

```
User requests "ls -la"
      │
      ▼
┌─────────────────────┐
│ 1. Schema validation │  inputSchema().safeParse(input)
│    Parse command,     │  Includes timeout, description,
│    timeout, etc.      │  run_in_background, dangerouslyDisableSandbox
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 2. validateInput()   │  - detectBlockedSleepPattern(): Block sleep>2s
│    Input validation   │    Suggest using Monitor tool
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 3. bashSecurity.ts   │  - extractQuotedContent(): Strip quoted content
│    AST security check │  - 23 checks (see table below)
│                      │  - parseForSecurity(): tree-sitter AST parsing
│                      │  - Zsh dangerous command detection (zmodload, sysopen, etc.)
│                      │  - Command substitution pattern detection ($(), ``, <(), etc.)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 4. bashPermissions   │  - splitCommand → Split compound commands
│    Permission chain   │  - Match allow/deny/ask rules per subcommand
│                      │  - stripSafeWrappers(): Remove timeout/env wrappers
│                      │  - bashClassifier (optional)
│                      │  - checkPathConstraints(): Path boundary check
│                      │  - checkSedConstraints(): sed edit check
│                      │  - checkPermissionMode(): Plan mode check
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 5. shouldUseSandbox  │  - SandboxManager.isSandboxingEnabled()
│    Sandbox decision   │  - dangerouslyDisableSandbox + policy check
│                      │  - containsExcludedCommand(): User-configured exclusions
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 6. exec() execution  │  - runShellCommand(): AsyncGenerator
│    Shell execution    │  - Periodically yield progress events
│                      │  - Timeout control (default 120s, max 600s)
│                      │  - Background task support (run_in_background)
│                      │  - Agentic mode auto-backgrounding (15s threshold)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 7. Result handling   │  - interpretCommandResult(): Semantic exit codes
│                      │  - trackGitOperations(): Git operation tracking
│                      │  - SandboxManager.annotateStderrWithSandboxFailures()
│                      │  - Large output persistence (>30K chars → disk file)
│                      │  - Image output detection and resizing
└─────────────────────┘
```

### 2.3 23 Security Checks in bashSecurity.ts

```typescript
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,          // Incomplete commands (missing closing quotes, etc.)
  JQ_SYSTEM_FUNCTION: 2,          // jq system() function calls
  JQ_FILE_ARGUMENTS: 3,           // jq file argument injection
  OBFUSCATED_FLAGS: 4,            // Obfuscated command-line flags
  SHELL_METACHARACTERS: 5,        // Shell metacharacter injection
  DANGEROUS_VARIABLES: 6,         // Dangerous environment variables
  NEWLINES: 7,                    // Newline injection in commands
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,  // $() command substitution
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,     // Input redirection
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,   // Output redirection
  IFS_INJECTION: 11,              // IFS field separator injection
  GIT_COMMIT_SUBSTITUTION: 12,    // Substitution in git commit messages
  PROC_ENVIRON_ACCESS: 13,        // /proc/self/environ access
  MALFORMED_TOKEN_INJECTION: 14,  // Malformed token injection
  BACKSLASH_ESCAPED_WHITESPACE: 15, // Backslash-escaped whitespace
  BRACE_EXPANSION: 16,            // Brace expansion
  CONTROL_CHARACTERS: 17,         // Control characters
  UNICODE_WHITESPACE: 18,         // Unicode whitespace
  MID_WORD_HASH: 19,              // Hash symbol in the middle of a word
  ZSH_DANGEROUS_COMMANDS: 20,     // Zsh dangerous commands
  BACKSLASH_ESCAPED_OPERATORS: 21, // Backslash-escaped operators
  COMMENT_QUOTE_DESYNC: 22,       // Comment/quote desynchronization
  QUOTED_NEWLINE: 23,             // Newlines inside quotes
}
```

Zsh-specific dangerous command set (20 commands): `zmodload` (module loading gateway), `emulate` (eval equivalent), `sysopen/sysread/syswrite` (file descriptor operations), `zpty` (pseudo-terminal execution), `ztcp/zsocket` (network exfiltration), `zf_rm/zf_mv`, etc. (builtins that bypass binary checks).

### 2.4 Command Semantics System

`commandSemantics.ts` implements semantic interpretation of command exit codes, avoiding false error reports for normal behavior:

- `grep` return code 1 → "No matches found" (not an error)
- `diff` return code 1 → "Files differ" (normal functionality)
- `test/[` return code 1 → "Condition is false"
- `find` return code 1 → "Some directories were inaccessible" (partial success)

---

## 3. Complete Anatomy of AgentTool

### 3.1 Built-in Agent Types

| Agent Type | Responsibility | Tool Restrictions | Model | Special Flags |
|-----------|---------------|-------------------|-------|--------------|
| `general-purpose` | General task execution | `['*']` all tools | Default sub-agent model | None |
| `Explore` | Read-only code exploration | No Agent/Edit/Write/Notebook | ant: inherit; external: haiku | `omitClaudeMd`, one-shot |
| `Plan` | Architecture design & planning | Same as Explore | inherit | `omitClaudeMd`, one-shot |
| `verification` | Implementation verification (try to break it) | No Agent/Edit/Write/Notebook | inherit | `background: true`, red label |
| `claude-code-guide` | Claude Code usage guide | — | — | Non-SDK entry only |
| `statusline-setup` | Status bar setup | — | — | — |
| `fork` (experimental) | Inherits parent's full context | `['*']` + `useExactTools` | inherit | `permissionMode: 'bubble'` |

### 3.2 Agent Mode Classification and Triggering

**1. Synchronous Foreground Agent (default)**: Waits for completion directly on the main thread, consuming each message from the AsyncGenerator.

**2. Asynchronous Background Agent**: Triggered by `run_in_background: true` or when `autoBackgroundMs` timeout is reached. Registered to `LocalAgentTask`, notifies completion via `<task-notification>`.

**3. Fork Agent (experimental)**: Triggered when the `FORK_SUBAGENT` feature flag is enabled and no `subagent_type` is specified. The sub-agent inherits the parent's full conversation context and system prompt.

**4. Remote Agent (ant-only)**: Triggered by `isolation: 'remote'`, launches in a remote CCR environment.

**5. Worktree Agent**: `isolation: 'worktree'` creates an isolated copy via git worktree.

**6. Teammate Agent (agent swarms)**: Created via `spawnTeammate()`, runs in an independent tmux pane.

### 3.3 AsyncGenerator Implementation of runAgent()

```typescript
export async function* runAgent({
  agentDefinition, promptMessages, toolUseContext, canUseTool,
  isAsync, forkContextMessages, querySource, override, model,
  maxTurns, availableTools, allowedTools, onCacheSafeParams,
  contentReplacementState, useExactTools, worktreePath, ...
}): AsyncGenerator<Message, void> {
```

Core flow:
1. **Create agent context**: `createSubagentContext()` clones readFileState and contentReplacementState from the parent
2. **Initialize MCP servers**: `initializeAgentMcpServers()` connects MCP servers defined in the agent definition
3. **Build system prompt**: `buildEffectiveSystemPrompt()` + `enhanceSystemPromptWithEnvDetails()`
4. **Message loop**: Calls `query()` to get stream events, filters and yields recordable messages
5. **Transcript recording**: `recordSidechainTranscript()` writes each message to session storage
6. **Cleanup**: `cleanupAgentTracking()`, MCP cleanup, Perfetto unregister

Key design: `runAgent` returns `AsyncGenerator<Message, void>`, allowing the caller (AgentTool.call) to consume messages one by one and send progress events to the SDK in real time.

### 3.4 Fork Agent's Prompt Cache Sharing Mechanism

The core goal of Fork Agent is for **all fork sub-agents to share the parent's prompt cache**. Key implementation details:

1. **`renderedSystemPrompt`**: The parent freezes the rendered system prompt bytes at the start of a turn, passing them to fork sub-agents via `toolUseContext.renderedSystemPrompt`. **It does not re-call `getSystemPrompt()`**, because GrowthBook state may change between cold and warm states (cold→warm divergence), causing different bytes and cache invalidation.

2. **`buildForkedMessages()`**: When constructing fork conversation messages:
   - Preserves all parent assistant messages (all tool_use blocks, thinking, text)
   - Replaces all `tool_result` blocks with a uniform placeholder `"Fork started — processing in background"`
   - This ensures the API request prefixes across different fork sub-agents have **exactly identical bytes**

3. **`useExactTools: true`**: The fork path skips `resolveAgentTools()` filtering and directly uses the parent's tool pool, ensuring the order and content of tool definitions in the API request are exactly the same.

```typescript
export const FORK_AGENT = {
  tools: ['*'],           // Inherit all parent tools
  model: 'inherit',       // Inherit parent model
  permissionMode: 'bubble', // Permission prompts bubble up to parent terminal
  getSystemPrompt: () => '', // Not used — passed via override.systemPrompt
}
```

---

## 4. ToolSearch Deferred Loading Mechanism

### 4.1 Decision Logic for shouldDefer and alwaysLoad

```typescript
export function isDeferredTool(tool: Tool): boolean {
  // 1. alwaysLoad: true → Never deferred (MCP tools can set this via _meta['anthropic/alwaysLoad'])
  if (tool.alwaysLoad === true) return false

  // 2. MCP tools are always deferred
  if (tool.isMcp === true) return true

  // 3. ToolSearch itself is never deferred
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // 4. In Fork mode, Agent tool is not deferred (needed at turn 1)
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    if (isForkSubagentEnabled()) return false
  }

  // 5. Brief tool (Kairos communication channel) is not deferred
  // 6. SendUserFile tool is not deferred

  // 7. Other tools are determined by the shouldDefer flag
  return tool.shouldDefer === true
}
```

### 4.2 Categories of Deferred Tools

| Category | Examples | Reason |
|----------|----------|--------|
| All MCP tools | `mcp__slack__*`, `mcp__github__*` | Workflow-specific, not needed in most sessions |
| Built-in tools with `shouldDefer: true` | NotebookEdit, WebFetch, WebSearch, EnterWorktree, ExitWorktree | Lower usage frequency |

**Key tools that are NOT deferred**: Bash, FileRead, FileEdit, FileWrite, Glob, Grep, Agent, ToolSearch, SkillTool, Brief (in Kairos mode)

### 4.3 Search Matching Algorithm

ToolSearchTool uses **multi-signal weighted scoring**:

```
Exact partial match (MCP): +12 pts  |  Exact partial match (regular): +10 pts
Partial containment match (MCP): +6 pts   |  Partial containment match (regular): +5 pts
searchHint match: +4 pts     |  Full name fallback match: +3 pts
Description word boundary match: +2 pts
```

Supports `select:` prefix for exact selection and `+` prefix for required-inclusion syntax. Returns `tool_reference` type content blocks, which the API server uses to decompress the full tool schema definitions.

---

## 5. MCP Tool Unified Adaptation

### 5.1 MCPTool Template Pattern

`MCPTool.ts` defines a **template object** that gets spread and overridden in `client.ts` via `{ ...MCPTool, ...overrides }`:

```typescript
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',                    // Overridden to mcp__server__tool
  maxResultSizeChars: 100_000,
  async description() { return DESCRIPTION },  // Overridden
  async prompt() { return PROMPT },            // Overridden
  async call() { return { data: '' } },        // Overridden to actual MCP call
  async checkPermissions() {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
  // inputSchema uses z.object({}).passthrough() to accept arbitrary input
})
```

### 5.2 Adaptation Logic in client.ts

Each MCP server tool is created as an independent Tool object on the client side:

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
  inputJSONSchema: tool.inputSchema,  // Uses JSON Schema directly, not converted to Zod
  async call(args, context, _canUseTool, parentMessage, onProgress) {
    // Actual call to the MCP client's callTool method
  }
}
```

Key design decisions:
- The `inputJSONSchema` field allows MCP tools to provide JSON Schema directly instead of Zod schemas
- MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) are mapped to internal Tool interface methods
- `checkPermissions` returns `passthrough`, indicating the generic permission system should handle it

---

## 6. Tool Concurrency Safety

### 6.1 Partitioned Execution Strategy

`toolOrchestration.ts` implements **partitioned execution** based on `isConcurrencySafe`:

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc, toolUse) => {
    const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data)
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)  // Merge into previous concurrent batch
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // New batch
    }
    return acc
  }, [])
}
```

Execution logic:
- **Concurrency-safe batches**: `runToolsConcurrently()` executes in parallel, with a concurrency limit of `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10). contextModifiers are applied sequentially after the batch completes.
- **Non-concurrency-safe batches**: `runToolsSerially()` executes serially, with each tool's contextModifier applied immediately.

### 6.2 Concurrency Safety Declarations for Each Tool

| Tool | isConcurrencySafe | Reason |
|------|-------------------|--------|
| BashTool | `this.isReadOnly(input)` | Only read-only commands are concurrency-safe |
| FileReadTool | `true` | Pure read operation |
| GlobTool | `true` | Pure search |
| GrepTool | `true` | Pure search |
| WebSearchTool | `true` | Stateless external query |
| AgentTool | `true` | Sub-agents have independent contexts |
| FileEditTool | `false` (default) | File writes must be serial |
| FileWriteTool | `false` (default) | File writes must be serial |
| SkillTool | `false` (default) | May have side effects |
| MCPTool | `readOnlyHint ?? false` | Follows MCP annotations |
| ToolSearchTool | `true` | Pure query |

### 6.3 Streaming Concurrency in StreamingToolExecutor

`StreamingToolExecutor.ts` implements more fine-grained concurrency control in streaming scenarios:

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

Rule: A new tool is only allowed to start in parallel when **all currently executing tools are concurrency-safe** AND the new tool is also concurrency-safe.

---

## 7. Tool Result Persistence

### 7.1 maxResultSizeChars Tiered System

```
                    System-level cap (DEFAULT_MAX_RESULT_SIZE_CHARS = 50K)
                                    │
                         ┌──────────┼──────────┐
                         │          │          │
                    BashTool      GrepTool   Most tools
                    30K chars     20K chars   100K chars
                         │                     │
                    Math.min(declared, 50K) Math.min(declared, 50K)
                    = 30K                  = 50K
```

**Special cases**:
- `FileReadTool.maxResultSizeChars = Infinity` — Never persisted, because after persistence the model would need to use Read to access the file, creating a circular read loop (Read → file → Read)
- `McpAuthTool.maxResultSizeChars = 10_000` — The smallest threshold; authentication information should be as concise as possible

### 7.2 Over-Limit Handling Flow

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

After exceeding the limit, the model receives:
```xml
<persisted-output>
Output too large (45.2 KB). Full output saved to: /path/to/tool-results/abc123.txt

Preview (first 2.0 KB):
[Preview of the first 2000 bytes]
...
</persisted-output>
```

### 7.3 Aggregate Budget Control

`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` limits the total size of all parallel tool_results within a single user message. When N parallel tools each produce results near the threshold, **the largest blocks are persisted first** until the budget is satisfied.

---

## 8. Complete Tool Inventory

### 8.1 Core Built-in Tools

| Tool Name | Type | Concurrency-Safe | Max Result | Deferred | Description |
|-----------|------|-------------------|-----------|----------|-------------|
| Agent | Sub-agent | true | 100K | No* | Sub-agent creation and management |
| Bash | Shell | Conditional | 30K | No | Command execution (most complex) |
| FileRead (Read) | File | true | Infinity | No | File reading |
| FileEdit (Edit) | File | false | 100K | No | File editing |
| FileWrite (Write) | File | false | 100K | No | File writing |
| Glob | Search | true | 100K | No | File pattern matching |
| Grep | Search | true | 20K | No | Content search |
| WebSearch | Network | true | 100K | Yes | Web search |
| WebFetch | Network | false | 100K | Yes | Web fetching |
| ToolSearch | Meta-tool | true | 100K | No | Tool discovery |
| Skill | Skill | false | 100K | No | Skill invocation |
| NotebookEdit | File | false | 100K | Yes | Jupyter editing |
| TodoWrite | State | false | 100K | No | Todo management |
| AskUserQuestion | Interactive | false | — | No | Ask user questions |
| TaskStop | Control | false | 100K | No | Stop task |
| TaskOutput | Control | true | 100K | No | Task output |
| Brief | Communication | true | 100K | No** | Brief messages (Kairos) |
| SendMessage | Communication | false | 100K | No | Send messages (swarms) |
| EnterPlanMode | Mode | true | 100K | No | Enter plan mode |
| ExitPlanModeV2 | Mode | false | — | No | Exit plan mode |

*Not deferred in Fork mode  **Not deferred in Kairos mode

### 8.2 Conditionally Loaded Tools

| Tool Name | Condition | Description |
|-----------|-----------|-------------|
| REPLTool | `USER_TYPE === 'ant'` | VM sandbox wrapper (Bash/Read/Edit execute inside VM) |
| ConfigTool | `USER_TYPE === 'ant'` | Configuration management |
| TungstenTool | `USER_TYPE === 'ant'` | Tungsten integration |
| PowerShellTool | `isPowerShellToolEnabled()` | Windows PowerShell |
| WebBrowserTool | `feature('WEB_BROWSER_TOOL')` | Browser automation |
| SleepTool | `feature('PROACTIVE')` or `feature('KAIROS')` | Delayed waiting |
| MonitorTool | `feature('MONITOR_TOOL')` | Event monitoring |
| CronCreate/Delete/List | `feature('AGENT_TRIGGERS')` | Scheduled task management |
| TeamCreate/TeamDelete | `isAgentSwarmsEnabled()` | Agent swarm management |
| TaskCreate/Get/Update/List | `isTodoV2Enabled()` | Task management v2 |
| EnterWorktree/ExitWorktree | `isWorktreeModeEnabled()` | Git worktree isolation |
| SnipTool | `feature('HISTORY_SNIP')` | History snipping |
| ListPeersTool | `feature('UDS_INBOX')` | Peer node listing |
| WorkflowTool | `feature('WORKFLOW_SCRIPTS')` | Workflow scripts |
| LSPTool | `ENABLE_LSP_TOOL` | Language Server Protocol |
| VerifyPlanExecutionTool | `CLAUDE_CODE_VERIFY_PLAN` | Plan verification |

---

## 9. Design Trade-offs and Insights

### 9.1 Structural Types vs. Traditional Inheritance

Claude Code chose `Tool` type + `buildTool` factory over `abstract class Tool`. This enables:
- MCP tools can be easily adapted via `{ ...MCPTool, ...overrides }`
- Each tool is a flat object with no prototype chain overhead
- TypeScript's `satisfies ToolDef<...>` verifies type correctness at compile time

### 9.2 Defense in Depth for Security

BashTool demonstrates a classic **defense in depth** approach:
1. **Syntax layer**: AST parsing + 23 injection pattern detections
2. **Permission layer**: Rule matching + classifier + path constraints
3. **Runtime layer**: Sandbox isolation + timeout control
4. **Output layer**: Sandbox violation annotation + large output truncation

Each layer assumes the other layers may be bypassed and independently provides security guarantees.

### 9.3 Elegant Design of Prompt Cache Sharing

The Fork Agent's cache sharing mechanism reflects extreme optimization of API costs:
- Freeze system prompt bytes (avoid GrowthBook state drift)
- Uniform placeholder replacement for tool_results (ensure identical prefix bytes)
- `useExactTools` maintains consistent tool definition ordering
- The trade-off is that fork sub-agents cannot independently modify the system prompt or tool set

### 9.4 Dead Code Elimination-Driven Module Design

`tools.ts` extensively uses the `feature()` + `require()` conditional import pattern:
```typescript
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool : null
```

Bun's bundler can evaluate `feature('X')` as constants at compile time, completely removing code for inactive tools. This also explains why `bashPermissions.ts` has comments about "DCE cliff" at the top — function complexity budgets limit Bun's ability to perform constant propagation.

### 9.5 Three-Tier Budget for Tool Results

1. **Tool-level** `maxResultSizeChars`: Each tool's declared value (20K~100K)
2. **System-level** `DEFAULT_MAX_RESULT_SIZE_CHARS` (50K): Hard cap, clipped by `Math.min`
3. **Message-level** `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (200K): Aggregate budget for all parallel results within a single message
4. **GrowthBook override** `tengu_satin_quoll`: Remote dynamic adjustment of specific tool thresholds

This tiered approach ensures that the context window is never exhausted by tool results across various scenarios (single tool with large output, N parallel tools, special needs requiring remote tuning).
