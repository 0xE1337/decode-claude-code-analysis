# 07 - Multi-Agent Collaboration System: Maximum Depth Analysis


## 1. Architecture Overview

Claude Code's multi-agent collaboration system is composed of the following core modules:

```
AgentTool.tsx (900+ lines)  ─── Unified entry point, all Agent lifecycle management
  ├── runAgent.ts          ─── Low-level execution engine: query() loop + MCP initialization
  ├── forkSubagent.ts      ─── Fork mode message construction & caching strategy
  ├── agentToolUtils.ts    ─── Tool pool pruning, async lifecycle management
  ├── resumeAgent.ts       ─── Resume background Agent from on-disk transcript
  ├── builtInAgents.ts     ─── Built-in Agent registry
  └── built-in/            ─── 6 built-in Agent definitions

coordinatorMode.ts         ─── Coordinator mode toggle + Worker system prompt
spawnMultiAgent.ts         ─── Teammate spawning via tmux/iTerm2/in-process
SendMessageTool.ts         ─── Cross-Agent message routing (local/UDS/Bridge)
TeamCreateTool.ts          ─── Team creation & TeamFile management
worktree.ts                ─── Git Worktree isolation: create/detect changes/cleanup
bridge/ (31 files)         ─── Remote Control REPL bridge (not for inter-Agent communication)
```

---

## 2. AgentTool's 6 Operating Modes

### Mode Comparison Table

| Dimension | Foreground (Sync) | Background (Async) | Fork | Worktree | Remote | Teammate |
|------|-------------|-------------|------|----------|--------|----------|
| **Trigger Condition** | Default mode | `run_in_background=true` or `selectedAgent.background=true` | `subagent_type` omitted + FORK_SUBAGENT feature gate | `isolation="worktree"` | `isolation="remote"` (ant-only) | Provides `name` + `team_name` |
| **Process Model** | Same process, blocks parent turn | Same process, async Promise | Same process, forced async | Same process + independent git directory | Remote CCR environment | tmux pane / iTerm2 tab / in-process |
| **Context Inheritance** | None (fresh prompt) | None | Full parent context + system prompt | Can overlay Fork context | None | None (communicates via mailbox) |
| **Tool Pool** | `resolveAgentTools()` pruned | Same + `ASYNC_AGENT_ALLOWED_TOOLS` filter | Parent's exact tool pool (`useExactTools`) | Same as Async | N/A | Independent tool pool |
| **Cache Efficiency** | Independent cache chain | Independent cache chain | Shares prompt cache with parent | Independent | Independent | Independent |
| **Isolation Level** | Shared CWD | Shared CWD | Shared CWD | Independent worktree directory | Fully isolated sandbox | Shared/independent CWD |
| **Permission Model** | Inherit/override | `shouldAvoidPermissionPrompts` | `bubble` (bubbles up to parent terminal) | Inherit | N/A | Inherits leader mode |
| **Result Return** | Directly returns tool_result | `<task-notification>` user message | `<task-notification>` | `<task-notification>` + worktree path | Remote polling | mailbox |

### Core Routing Logic for Mode Selection

In `AgentTool.call()`, routing decisions are executed in the following priority order:

```typescript
// 1. Teammate routing (highest priority)
if (teamName && name) {
  return spawnTeammate({ ... })  // → tmux / in-process
}

// 2. Fork routing
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : 'general-purpose')
const isForkPath = effectiveType === undefined  // subagent_type omitted + gate enabled

// 3. Remote isolation (ant-only)
if ("external" === 'ant' && effectiveIsolation === 'remote') {
  return teleportToRemote({ ... })
}

// 4. Worktree isolation
if (effectiveIsolation === 'worktree') {
  worktreeInfo = await createAgentWorktree(slug)
}

// 5. Sync/Async decision
const shouldRunAsync = (run_in_background || selectedAgent.background
  || isCoordinator || forceAsync || assistantForceAsync) && !isBackgroundTasksDisabled
```

---

## 3. Fork Agent's Cache Innovation

### 3.1 Core Design Goal

Fork mode is Claude Code's most elegant cache optimization. Its core idea is: **let multiple sub-Agents share the parent's prompt cache, avoiding redundant cache creation**.

### 3.2 Byte-Level Prompt Cache Sharing Mechanism

Key constraint: all Fork sub-Agents must produce **byte-identical** API request prefixes. Implementation approach:

**System prompt inheritance**: Fork sub-Agents do not use their own system prompt; instead, they directly inherit the parent's rendered system prompt bytes:

```typescript
// Fork path in AgentTool.tsx
if (isForkPath) {
  if (toolUseContext.renderedSystemPrompt) {
    forkParentSystemPrompt = toolUseContext.renderedSystemPrompt  // Directly reuse parent's rendered bytes
  } else {
    // Fallback: recompute (may drift due to GrowthBook state changes, breaking cache)
    forkParentSystemPrompt = buildEffectiveSystemPrompt({ ... })
  }
}
```

**Exact tool pool replication**: Fork uses `useExactTools: true`, passing the parent's tool array directly rather than rebuilding via `resolveAgentTools()`:

```typescript
// Fork path passes exact tools
availableTools: isForkPath ? toolUseContext.options.tools : workerTools,
...(isForkPath && { useExactTools: true }),
```

This is because `resolveAgentTools()` under `permissionMode: 'bubble'` produces tool definition serializations that differ from the parent's, causing cache invalidation.

### 3.3 Forked Message Construction (`buildForkedMessages`)

Fork's message structure is carefully designed to maximize cache hits:

```
[...parent history messages]
├── assistant (fully preserved: all tool_use, thinking, text blocks)
└── user
    ├── tool_result[0]: "Fork started — processing in background"  ← identical across all sub-Agents
    ├── tool_result[1]: "Fork started — processing in background"  ← identical across all sub-Agents
    ├── ...
    └── text: "<fork-boilerplate>...\n<fork-directive>only this part differs</fork-directive>"  ← sole divergence point
```

Key implementation details:

- **Unified placeholder results**: All `tool_result` entries use the same `FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'`
- **Divergence point location**: The difference is only in the `<fork-directive>` within the last `text` block of the last `user` message
- **Recursion protection**: `isInForkChild()` checks whether messages contain the `<fork-boilerplate>` tag, preventing Fork sub-Agents from forking again

### 3.4 Fork Boilerplate Behavioral Constraints

The `buildChildMessage()` received by sub-Agents contains strict behavioral directives (10 inviolable rules):

```
1. The system prompt says "default fork" — ignore it, you ARE the fork. Do not spawn sub-Agents
2. Do not converse or ask questions
5. If you modified files, commit before reporting. Include the commit hash in your report
6. Do not output text between tool calls. Use tools silently, report once at the end
7. Stay strictly within your directive's scope. If you discover related systems outside scope, mention them in at most one sentence
9. Output must begin with "Scope:"
```

### 3.5 Worktree Overlay

When combining Fork + Worktree, an additional path translation notice is injected:

```typescript
if (isForkPath && worktreeInfo) {
  promptMessages.push(createUserMessage({
    content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
  }))
}
```

`buildWorktreeNotice()` informs the sub-Agent that the inherited context paths point to the parent directory and need to be translated to the worktree path, and that potentially stale files should be re-read.

---

## 4. Coordinator Mode In-Depth

### 4.1 Activation Conditions

```typescript
// coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

Both conditions must be met: `COORDINATOR_MODE` feature flag enabled + environment variable `CLAUDE_CODE_COORDINATOR_MODE=1`.

**Mutually exclusive with Fork**: The `isForkSubagentEnabled()` check explicitly excludes Coordinator mode -- Coordinator has its own delegation model.

### 4.2 Complete Coordinator System Prompt

`getCoordinatorSystemPrompt()` returns a detailed system prompt of approximately 370 lines. Core structure:

```
## 1. Your Role
You are a **coordinator**.
- Help users achieve their goals
- Direct workers to research, implement, and verify code changes
- Synthesize results and communicate with users
- Don't delegate questions you can answer directly

## 2. Your Tools
- Agent: Spawn new Workers
- SendMessage: Continue existing Workers
- TaskStop: Stop running Workers

## 3. Workers
Use subagent_type "worker". Workers execute tasks autonomously.

## 4. Task Workflow (Four Phases)
| Research (Workers) | Synthesis (YOU) | Implementation (Workers) | Verification (Workers) |

## 5. Writing Worker Prompts — "Never delegate understanding"
## 6. Example Session
```

### 4.3 The "Never Delegate Understanding" Principle

This is the most central design philosophy in the Coordinator system prompt, manifested at multiple levels:

**Explicit constraints in the system prompt**:

```
Never write "based on your findings" or "based on the research."
These phrases delegate understanding to the worker instead of doing it yourself.
You never hand off understanding to another worker.
```

**Anti-pattern examples**:
```
// Bad — lazy delegation
Agent({ prompt: "Based on your findings, fix the auth bug", ... })

// Good — precise instructions after synthesis
Agent({ prompt: "Fix the null pointer in src/auth/validate.ts:42. The user field
on Session is undefined when sessions expire but the token remains cached.
Add a null check before user.id access...", ... })
```

**Continue vs Spawn decision matrix**:

| Scenario | Mechanism | Reason |
|------|------|------|
| The files explored during research are exactly the ones that need editing | Continue (SendMessage) | Worker already has file context |
| Research was broad but implementation scope is narrow | Spawn new Worker | Avoid dragging in exploration noise |
| Correcting a failure or continuing work | Continue | Worker has error context |
| Verifying code written by another Worker | Spawn new Worker | Verifier needs "fresh eyes" |

### 4.4 Worker Tool Pool Pruning

```typescript
// coordinatorMode.ts
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,    // TeamCreate — Workers should not create teams
  TEAM_DELETE_TOOL_NAME,    // TeamDelete — Workers should not delete teams
  SEND_MESSAGE_TOOL_NAME,   // SendMessage — Workers should not communicate directly
  SYNTHETIC_OUTPUT_TOOL_NAME // SyntheticOutput — Internal mechanism
])

// Worker tools = ASYNC_AGENT_ALLOWED_TOOLS - INTERNAL_WORKER_TOOLS
const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
  .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
  .sort()
  .join(', ')
```

Worker context injection is implemented via `getCoordinatorUserContext()`, which includes:
- Available tool list
- Connected MCP server names
- Scratchpad directory path (if enabled)

### 4.5 Forced Async in Coordinator Mode

```typescript
const shouldRunAsync = (... || isCoordinator || ...) && !isBackgroundTasksDisabled
```

In Coordinator mode, all Workers are forced to run asynchronously. Results are returned as user messages in `<task-notification>` XML format.

---

## 5. Team Communication Mechanism

### 5.1 SendMessage Addressing Modes

`SendMessageTool` supports four addressing protocols:

```typescript
const inputSchema = z.object({
  to: z.string()  // Addressing target
  // Supported formats:
  // "researcher"           → Address Teammate by name
  // "*"                    → Broadcast to all Teammates
  // "uds:/path/to.sock"   → Unix Domain Socket (local cross-session)
  // "bridge:session_..."   → Remote Control cross-machine communication
})
```

### 5.2 Complete Message Routing Decision Tree

```
SendMessage.call(input)
│
├── 1. Bridge route (feature UDS_INBOX + addr.scheme === 'bridge')
│   └── postInterClaudeMessage(target, message)  → Cross-machine HTTP API
│
├── 2. UDS route (feature UDS_INBOX + addr.scheme === 'uds')
│   └── sendToUdsSocket(addr.target, message)    → Unix Domain Socket
│
├── 3. Sub-Agent route (name or agentId matches agentNameRegistry/LocalAgentTask)
│   ├── task.status === 'running':
│   │   └── queuePendingMessage(agentId, message)  → Delivered on next tool turn
│   ├── task.status === stopped:
│   │   └── resumeAgentBackground(agentId, message) → Resume from transcript
│   └── task does not exist:
│       └── resumeAgentBackground(agentId, message) → Attempt recovery from disk
│
├── 4. Broadcast route (to === '*')
│   └── handleBroadcast()  → Iterate teamFile.members, writeToMailbox for each
│
└── 5. Teammate route (default)
    └── handleMessage()    → writeToMailbox(recipientName, ...)
```

### 5.3 Mailbox Communication

Communication between Teammates is based on a filesystem mailbox:

```typescript
// Core operation in handleMessage
await writeToMailbox(recipientName, {
  from: senderName,
  text: content,
  summary,
  timestamp: new Date().toISOString(),
  color: senderColor,
}, teamName)
```

Mailbox files are stored under the team directory, with each Teammate having its own inbox. Messages are delivered automatically -- there is no need to actively check the inbox.

### 5.4 tmux vs In-Process Selection Strategy

Backend detection logic in `spawnMultiAgent.ts`:

```typescript
let detectionResult = await detectAndGetBackend()
// Detection result may include: needsIt2Setup

// Backend types (BackendType):
// - 'tmux':       tmux available, create pane and send command
// - 'iterm2':     iTerm2 + it2 tools, use native split panes
// - 'in-process': Run in-process, shared memory

// tmux spawn flow:
// 1. ensureSession(sessionName)        → Ensure tmux session exists
// 2. createTeammatePaneInSwarmView()   → Create pane in swarm view
// 3. sendCommandToPane(paneId, cmd)    → Send spawn command to pane
```

**Special restrictions for in-process Teammates**:
```typescript
// Cannot spawn background Agents
if (isInProcessTeammate() && teamName && run_in_background === true) {
  throw new Error('In-process teammates cannot spawn background agents.')
}
// Cannot spawn nested Teammates
if (isTeammate() && teamName && name) {
  throw new Error('Teammates cannot spawn other teammates — the team roster is flat.')
}
```

### 5.5 Structured Message Protocol

In addition to plain text, `SendMessage` supports three structured message types:

```typescript
const StructuredMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown_request'), reason: z.string().optional() }),
  z.object({ type: z.literal('shutdown_response'), request_id, approve, reason }),
  z.object({ type: z.literal('plan_approval_response'), request_id, approve, feedback }),
])
```

- **shutdown_request**: Request a Teammate to shut down (initiated by lead)
- **shutdown_response**: Teammate replies with approval/rejection of shutdown
- **plan_approval_response**: Lead approves/rejects a plan submitted by a Teammate

---

## 6. Worktree Isolation

### 6.1 Creation Flow

Complete flow of `createAgentWorktree(slug)`:

```
1. validateWorktreeSlug(slug)           → Prevent path traversal attacks
2. hasWorktreeCreateHook()?
   ├── Yes: executeWorktreeCreateHook() → User-defined VCS hook
   └── No: Git worktree flow
       a. findCanonicalGitRoot()        → Find the main repository (not a nested worktree)
       b. getOrCreateWorktree(root, slug)
          ├── readWorktreeHeadSha()     → Fast recovery path (read .git pointer file, no subprocess)
          ├── If exists: return existing worktree
          └── If not exists:
              i.   git fetch origin <defaultBranch>  (with GIT_TERMINAL_PROMPT=0)
              ii.  git worktree add -B worktree-<slug> <path> <base>
              iii. (optional) git sparse-checkout set --cone -- <paths>
       c. symlinkDirectories()          → Symlink node_modules etc. to avoid disk bloat
       d. copyWorktreeIncludeFiles()    → Copy gitignored files matched by .worktreeinclude
       e. saveCurrentProjectConfig()    → Copy CLAUDE.md and other configurations
```

### 6.2 Preventing Multi-Agent Git Conflicts

Worktrees prevent conflicts through the following mechanisms:

1. **Branch isolation**: Each worktree uses a unique branch name `worktree-<flattenSlug>`
2. **Directory isolation**: Path is `.claude/worktrees/<flattenSlug>`, physically fully isolated
3. **`-B` flag**: `git worktree add -B` resets orphan branches with the same name, avoiding stale state
4. **Slug flattening**: `user/feature` becomes `user+feature`, preventing git ref D/F conflicts and nested worktree issues
5. **`findCanonicalGitRoot()`**: Ensures all worktrees are created under the main repository's `.claude/worktrees/`, rather than nested inside an existing worktree

### 6.3 Cleanup Flow

```typescript
async cleanupWorktreeIfNeeded(): Promise<{ worktreePath?, worktreeBranch? }> {
  // Hook-based worktree: always preserved (cannot detect VCS changes)
  if (hookBased) return { worktreePath }

  // Detect changes: git status --porcelain + git rev-list --count <base>..HEAD
  if (headCommit) {
    const changed = await hasWorktreeChanges(worktreePath, headCommit)
    if (!changed) {
      // No changes → auto-cleanup
      await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
      return {}
    }
  }
  // Has changes → preserve worktree, return path and branch for user inspection
  return { worktreePath, worktreeBranch }
}
```

`hasWorktreeChanges()` checks two dimensions:
- `git status --porcelain`: Detects uncommitted modifications
- `git rev-list --count <headCommit>..HEAD`: Detects new commits

---

## 7. The True Purpose of the Bridge Module

### 7.1 Core Positioning

**Bridge is not an inter-Agent communication mechanism; it is a REPL bridge layer for Remote Control.** It enables the claude.ai web interface to remotely control a locally running Claude Code instance.

### 7.2 31 Files Grouped by Function

| Group | File | Function |
|------|------|------|
| **Core Bridge** | `replBridge.ts` | Main REPL bridge core: environment registration, message polling, WebSocket connection management |
| | `remoteBridgeCore.ts` | Env-less bridge core (v2): direct connection without Environments API |
| | `bridgeMain.ts` | `claude remote-control` command entry: multi-session management, spawn mode |
| | `initReplBridge.ts` | REPL-specific initialization: read bootstrap state, OAuth, session title |
| **Config & Enablement** | `bridgeConfig.ts` | Bridge URL, token configuration |
| | `bridgeEnabled.ts` | GrowthBook gate checks, minimum version verification |
| | `envLessBridgeConfig.ts` | v2 env-less configuration |
| | `pollConfig.ts` / `pollConfigDefaults.ts` | Polling interval configuration |
| **API Layer** | `bridgeApi.ts` | HTTP API client: registerEnvironment, pollForWork, ack, stop |
| | `codeSessionApi.ts` | CCR v2 session API: create sessions, obtain credentials |
| | `createSession.ts` | Create/archive bridge sessions |
| **Message Processing** | `bridgeMessaging.ts` | Transport-layer message parsing: type guards, message filtering, deduplication |
| | `inboundMessages.ts` | Inbound message extraction: content and UUID |
| | `inboundAttachments.ts` | Inbound attachment handling |
| **Transport** | `replBridgeTransport.ts` | v1 (WebSocket) and v2 (SSE+CCRClient) transport layer |
| **Security & Auth** | `jwtUtils.ts` | JWT token management: refresh scheduling |
| | `trustedDevice.ts` | Trusted device token |
| | `workSecret.ts` | Work Secret decoding, SDK URL construction, worker registration |
| | `sessionIdCompat.ts` | Session ID format compatibility conversion |
| **Session Management** | `sessionRunner.ts` | Subprocess spawner: spawn Claude Code CLI to handle remote sessions |
| | `replBridgeHandle.ts` | Global registration and access of bridge handles |
| | `bridgePointer.ts` | Crash recovery pointer: detect abnormal exits and resume sessions |
| **UI & Debug** | `bridgeUI.ts` | Status display: banner, session status, QR code |
| | `bridgeStatusUtil.ts` | Formatting utilities (duration, etc.) |
| | `bridgeDebug.ts` | Fault injection and debug handles |
| | `debugUtils.ts` | Error descriptions, HTTP status extraction |
| **Traffic Management** | `capacityWake.ts` | Capacity wake signal: wake idle polling when new work arrives |
| | `flushGate.ts` | Flush gate: ensure messages are sent in order |
| **Permissions** | `bridgePermissionCallbacks.ts` | Permission callback registration |
| **Types** | `types.ts` | All type definitions: WorkResponse, BridgeConfig, SessionHandle, etc. |

### 7.3 Two Generations of Architecture

**v1 (Env-based)**: `replBridge.ts`
```
Register environment → Poll for work → Acknowledge → Spawn subprocess → WebSocket communication → Heartbeat
```

**v2 (Env-less)**: `remoteBridgeCore.ts`
```
POST /v1/code/sessions → POST /bridge (obtain JWT) → SSE + CCRClient
```

v2 removes the poll/dispatch layer of the Environments API, connecting directly to session-ingress.

### 7.4 Spawn Mode

`bridgeMain.ts` supports three session directory strategies:

```typescript
type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
// single-session: One session in CWD, bridge is destroyed when session ends
// worktree: Persistent service, each session gets an independent git worktree
// same-dir: Persistent service, all sessions share CWD (potential conflicts)
```

---

## 8. shouldRunAsync Decision Tree

Complete async decision logic:

```
shouldRunAsync =
  (
    run_in_background === true           // User explicitly requests background
    || selectedAgent.background === true  // Agent definition declares background
    || isCoordinator                      // Coordinator mode forces async
    || forceAsync                         // Fork experiment forces all spawns async
    || assistantForceAsync                // KAIROS assistant mode forces async
    || proactiveModule?.isProactiveActive() // Proactive mode active forces async
  )
  && !isBackgroundTasksDisabled          // Global background tasks not disabled
```

Key behavioral differences:

- **Sync Agent**: Blocks the parent turn, directly returns `AgentToolResult`
- **Async Agent**: Registers a `LocalAgentTask`, returns `{ status: 'async_launched', agentId, outputFile }`
- **After Async completes**: Results are injected as user-role messages in `<task-notification>` format via `enqueueAgentNotification()`

### Auto-background Mechanism

```typescript
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS)
    || getFeatureValue('tengu_auto_background_agents', false)) {
    return 120_000  // Auto-convert to background after 120 seconds
  }
  return 0
}
```

---

## 9. Agent Memory System

`agentMemory.ts` implements a three-tier persistent memory system:

```typescript
type AgentMemoryScope = 'user' | 'project' | 'local'
// user:    ~/.claude/agent-memory/<agentType>/    → Cross-project universal memory
// project: <cwd>/.claude/agent-memory/<agentType>/ → Project-level shared memory (VCS-trackable)
// local:   <cwd>/.claude/agent-memory-local/<agentType>/ → Local private (not in VCS)
```

Agent definitions declare which level to use via the `memory: 'user' | 'project' | 'local'` frontmatter. The system automatically injects memory content into the system prompt via `loadAgentMemoryPrompt()` when the Agent starts.

---

## 10. Built-in Agent Registry

`builtInAgents.ts` manages built-in Agent registration, with the pattern depending on the operating mode:

```typescript
function getBuiltInAgents(): AgentDefinition[] {
  // Coordinator mode → use getCoordinatorAgents() (worker only)
  if (isCoordinatorMode()) return getCoordinatorAgents()

  // Normal mode:
  const agents = [
    GENERAL_PURPOSE_AGENT,   // General-purpose Agent (required)
    STATUSLINE_SETUP_AGENT,  // iTerm2 status line setup
  ]
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)  // Explore and Plan Agents
  }
  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)    // Claude Code usage guide
  }
  if (feature('VERIFICATION_AGENT')) {
    agents.push(VERIFICATION_AGENT)         // Verification Agent
  }
  return agents
}
```

Special marker `ONE_SHOT_BUILTIN_AGENT_TYPES`: `Explore` and `Plan` are one-shot Agents that do not need the agentId/SendMessage prompt in the trailing info, saving approximately 135 characters per invocation.

---

## Summary

Claude Code's multi-agent system is a sophisticated layered architecture:

1. **AgentTool is the unified entry point**, covering all scenarios from simple delegation to full isolation through 6 operating modes
2. **Fork mode is the greatest cache innovation**, achieving cross-sub-Agent prompt cache sharing through byte-level system prompt inheritance and unified placeholder results
3. **Coordinator mode implements the "never delegate understanding" design philosophy**, ensuring through detailed system prompts that the Coordinator always synthesizes rather than forwards
4. **Worktree provides Git-level physical isolation**, combined with intelligent cleanup to avoid disk bloat
5. **Team communication is implemented via mailbox + SendMessage**, supporting three transport modes: local, UDS, and cross-machine
6. **The Bridge module is Remote Control infrastructure**, enabling the claude.ai web interface to remotely control local Claude Code -- it is not an inter-Agent communication mechanism
