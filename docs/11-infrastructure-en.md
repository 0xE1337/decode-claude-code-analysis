# 11 - Deep Analysis of Infrastructure Modules

## Overview

Claude Code's infrastructure layer is composed of modules including tasks/, state/, remote/, migrations/, keybindings/, cli/, server/, vim/, upstreamproxy/, memdir/, and utils/. These modules span task scheduling, state management, remote execution, model evolution, input handling, proxy services, memory systems, and more, forming the foundational skeleton of the entire application. The following provides an in-depth analysis of each.

---

## I. Deep Dive into the Task System

### 1.1 Seven Task Types and Lifecycle

The Task system is defined across `Task.ts` (base types) + `tasks.ts` (registry) + `tasks/` directory (implementations). Core type hierarchy:

```typescript
// Task.ts - Seven task types
export type TaskType =
  | 'local_bash'      // Prefix 'b' - Local Shell commands
  | 'local_agent'     // Prefix 'a' - Local Agent subtasks
  | 'remote_agent'    // Prefix 'r' - Remote CCR sessions
  | 'in_process_teammate' // Prefix 't' - In-process teammates
  | 'local_workflow'  // Prefix 'w' - Local workflows (feature-gated)
  | 'monitor_mcp'     // Prefix 'm' - MCP monitoring (feature-gated)
  | 'dream'           // Prefix 'd' - Dream tasks (memory distillation)

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

**Task ID Generation Rules**: A prefix letter + 8 base36 random characters (`randomBytes(8)` mapped to `0-9a-z`), yielding approximately 2.8 trillion combinations to prevent symlink collision attacks. Main session backgrounded tasks use the `'s'` prefix for differentiation.

**Lifecycle Comparison Table**:

| Task Type | Trigger Method | Execution Location | Output Storage | Backgrounding | Kill Mechanism |
|---------|---------|---------|---------|--------|----------|
| `local_bash` | BashTool/BackgroundBashTool | Local subprocess | Separate transcript file | Supports ctrl+b | Process SIGTERM |
| `local_agent` | AgentTool invocation | Local query() loop | Agent transcript file | Supported | AbortController.abort() |
| `remote_agent` | teleport/ultraplan | CCR cloud container | CCR server-side | Always background | WebSocket interrupt |
| `in_process_teammate` | Swarm team system | Same process | Shared AppState | Always background | AbortController |
| `local_workflow` | feature('WORKFLOW_SCRIPTS') | Local | Workflow output | Supported | AbortController |
| `monitor_mcp` | feature('MONITOR_TOOL') | MCP connection | MCP event stream | Always background | Disconnect |
| `dream` | Memory distillation /dream | Local sideQuery | Memory directory | Always background | AbortController |

### 1.2 Main Session Backgrounding Mechanism

`LocalMainSessionTask.ts` (480 lines) implements a complete main session backgrounding protocol:

**Trigger Flow**: User double-presses `Ctrl+B` -> `registerMainSessionTask()` creates a task -> `startBackgroundSession()` forks the current message into an independent `query()` call.

```typescript
// Key data structure
export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'  // Distinguishes from regular agent tasks
}
```

**Core Design**:
- **Separate Transcript**: Background tasks write to `getAgentTranscriptPath(taskId)` instead of the main session transcript, preventing data contamination after `/clear`
- **Symlink Survival**: Uses `initTaskOutputAsSymlink()` to link taskId to an independent file; symlinks are automatically re-linked on `/clear`
- **AgentContext Isolation**: Uses `AsyncLocalStorage`-wrapped `runWithAgentContext()` to ensure skill invocation isolation between concurrent queries
- **Notification Deduplication**: `notified` flag with atomic check-and-set (CAS) prevents duplicate notifications from both abort and complete paths
- **Foreground Restoration**: `foregroundMainSessionTask()` marks a task as `isBackgrounded: false` while returning any previously foregrounded task to background

### 1.3 Relationship Between Task and Agent

- `Task` (`Task.ts`) is the scheduling unit, defining the `kill()` interface and ID generation
- `Agent` (AgentTool) is the execution unit, running the query loop
- Relationship: A `local_agent` Task corresponds to one Agent instance; `in_process_teammate` corresponds to one member in a swarm; `remote_agent` corresponds to one CCR cloud session
- `tasks.ts`'s `getTaskByType()` is the polymorphic dispatch entry point; `stopTask.ts`'s `stopTask()` is the unified termination entry point

```typescript
// tasks.ts - Conditionally load feature-gated tasks
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
  : null
```

---

## II. State Management System

### 2.1 The Store's 35-Line Minimalist Implementation

`state/store.ts` is the core of the entire application's state management — only 35 lines of code:

```typescript
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // Skip on referential equality
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

**Design Comparison with Redux/Zustand**:

| Feature | Claude Code Store | Redux | Zustand |
|------|------------------|-------|---------|
| Core code size | 35 lines | ~2000 lines | ~200 lines |
| Update method | `setState(updater)` | `dispatch(action)` | `set(partial)` |
| Middleware | None | Supported | Supported |
| Immutability | By convention (`DeepImmutable`) | Enforced (reducer) | By convention |
| Change detection | `Object.is` reference comparison | Reducer returns new object | `Object.is` |
| Side effects | `onChange` callback | middleware/saga/thunk | subscribe |
| DevTools | None | Supported | Supported |

**Rationale for Design Choices**: Claude Code is a TUI application and does not need Redux's action log/time-travel; the `onChange` callback pattern is sufficient for all cross-module side effects; the `DeepImmutable` type constraint guarantees immutability at compile time.

### 2.2 AppState's Massive Structure (570 Lines)

`AppStateStore.ts` defines the `AppState` type, containing approximately 100+ top-level fields covering the following functional domains:

| Domain | Key Fields | Description |
|--------|---------|------|
| Core Settings | `settings`, `verbose`, `mainLoopModel` | Model selection, settings |
| Permission Control | `toolPermissionContext`, `denialTracking` | Permission mode and denial tracking |
| Task System | `tasks`, `foregroundedTaskId`, `viewingAgentTaskId` | Task registry and view state |
| MCP System | `mcp.clients`, `mcp.tools`, `mcp.commands` | MCP server connections |
| Plugin System | `plugins.enabled`, `plugins.installationStatus` | Plugin management |
| Bridge Connection | `replBridgeEnabled/Connected/SessionActive` (9 fields) | Remote control bridge |
| Speculative Execution | `speculation`, `speculationSessionTimeSavedMs` | Predictive execution cache |
| Computer Use | `computerUseMcpState` (12 subfields) | macOS CU state |
| Tmux Integration | `tungstenActiveSession`, `tungstenPanelVisible` | Terminal panel |
| Browser Tools | `bagelActive`, `bagelUrl`, `bagelPanelVisible` | WebBrowser panel |
| Team Collaboration | `teamContext`, `inbox`, `workerSandboxPermissions` | Swarm-related |
| Ultraplan | `ultraplanLaunching/SessionUrl/PendingChoice` | Remote planning |
| Memory/Notifications | `notifications`, `elicitation`, `promptSuggestion` | Interaction state |

Notably, the `tasks` field is excluded from `DeepImmutable` because `TaskState` contains function types (such as `abortController`).

### 2.3 onChangeAppState Side Effect Handling

`onChangeAppState.ts` is a centralized side effect handler hooked into the Store's `onChange` callback. Its design philosophy is "single chokepoint" — all cross-module synchronization triggered by `setAppState` calls is handled here:

**Side Effect Chain**:
1. **Permission mode synchronization** (most complex): Detects `toolPermissionContext.mode` changes -> externalizes mode name (`bubble` -> `default`) -> notifies CCR (`notifySessionMetadataChanged`) + SDK (`notifyPermissionModeChanged`). Previously, 8+ change paths had only 2 correctly synchronized
2. **Model settings persistence**: `mainLoopModel` changes -> `updateSettingsForSource('userSettings', ...)` + `setMainLoopModelOverride()`
3. **Expanded view persistence**: `expandedView` changes -> `saveGlobalConfig()` writes `showExpandedTodos`/`showSpinnerTree`
4. **Verbose persistence**: Syncs to `globalConfig.verbose`
5. **Tungsten panel**: `tungstenPanelVisible` sticky toggle persistence (ant-only)
6. **Auth cache cleanup**: Clears API key/AWS/GCP credential caches when `settings` change
7. **Environment variable reapplication**: Calls `applyConfigEnvironmentVariables()` when `settings.env` changes

### 2.4 Selectors and View Helpers

`selectors.ts` provides pure functions to derive computed values from AppState:
- `getViewedTeammateTask()` - Gets the currently viewed teammate task
- `getActiveAgentForInput()` - Determines user input routing target (leader/viewed/named_agent)

`teammateViewHelpers.ts` manages teammate transcript viewing state:
- `enterTeammateView()` - Enters view (sets `retain: true` to prevent eviction)
- `exitTeammateView()` - Exits (calls `release()` to clean up messages, sets `evictAfter` for delayed cleanup)
- `stopOrDismissAgent()` - Context-sensitive: running -> abort; terminal -> dismiss

---

## III. Model Evolution Tracking

### 3.1 Complete Migration Script List

The `migrations/` directory contains 11 migration scripts, categorized into three types:

**Model Name Migrations (5)**:

| Script | Migration Path | Condition |
|------|---------|------|
| `migrateFennecToOpus.ts` | fennec-latest -> opus, fennec-fast-latest -> opus[1m]+fast | ant-only |
| `migrateLegacyOpusToCurrent.ts` | claude-opus-4-0/4-1 -> opus | firstParty + GB gate |
| `migrateOpusToOpus1m.ts` | opus -> opus[1m] | Max/Team Premium (not Pro) |
| `migrateSonnet1mToSonnet45.ts` | sonnet[1m] -> sonnet-4-5-20250929[1m] | One-time, globalConfig flag |
| `migrateSonnet45ToSonnet46.ts` | sonnet-4-5-20250929 -> sonnet | Pro/Max/Team Premium firstParty |

**Settings Migrations (5)**:

| Script | Function |
|------|------|
| `migrateAutoUpdatesToSettings.ts` | globalConfig.autoUpdates -> settings.env.DISABLE_AUTOUPDATER |
| `migrateBypassPermissionsAcceptedToSettings.ts` | globalConfig -> settings.skipDangerousModePermissionPrompt |
| `migrateEnableAllProjectMcpServersToSettings.ts` | projectConfig MCP approval -> localSettings |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | replBridgeEnabled -> remoteControlAtStartup |
| `resetAutoModeOptInForDefaultOffer.ts` | Clears skipAutoPermissionPrompt to show new options |

**Default Model Reset (1)**:

| Script | Function |
|------|------|
| `resetProToOpusDefault.ts` | Auto-migrates Pro users to Opus 4.5 default |

### 3.2 Model Naming Evolution Timeline

The following naming evolution timeline can be reconstructed from the migration scripts:

```
Period 1 (Internal Codename Era):
  fennec-latest          -> opus     (Internal codename fennec transitions to public opus)
  fennec-latest[1m]      -> opus[1m]
  fennec-fast-latest     -> opus[1m] + fastMode
  opus-4-5-fast          -> opus + fastMode

Period 2 (Opus Version Iterations):
  claude-opus-4-20250514    (Opus 4.0, released 2025-05-14)
  claude-opus-4-0           (Short name)
  claude-opus-4-1-20250805  (Opus 4.1, released 2025-08-05)
  claude-opus-4-1           (Short name)
  -> All migrated to 'opus' alias (pointing to Opus 4.6)

Period 3 (Opus 1M Merge):
  opus -> opus[1m]  (Max/Team Premium users merged to 1M version)

Period 4 (Sonnet Version Iterations):
  sonnet[1m] -> sonnet-4-5-20250929[1m]  (Sonnet alias starts pointing to 4.6)
  sonnet-4-5-20250929 -> sonnet           (Eventually all migrated to sonnet alias)
```

### 3.3 Model Alias System

Aliases are implemented via `utils/model/aliases.ts`; migration scripts only operate on the `userSettings.model` field. Key design principles:
- Only migrates `userSettings` (user-level), never touches `projectSettings`/`localSettings`/`policySettings`
- At runtime, `parseUserSpecifiedModel()` still provides fallback remapping
- Idempotency is guaranteed through completion flags in `globalConfig`

---

## IV. Utils Directory Classification

The `utils/` directory contains 564 files (290 top-level + 274 in subdirectories), totaling approximately 88,466 lines of code. Classified by subdirectory:

### 4.1 Subdirectory Function Classification Table

| Subdirectory | File Count | Functional Domain |
|--------|--------|---------|
| `bash/` | 15+ | Bash parser (AST/heredoc/pipes/quoting) |
| `shell/` | 10 | Shell provider abstraction (bash/powershell) |
| `powershell/` | 3 | PowerShell dangerous cmdlet detection |
| `permissions/` | 16+ | Permission system (classifier/denial/filesystem/mode) |
| `model/` | 16 | Model management (alias/config/capability/deprecation/providers) |
| `settings/` | 14+ | Settings system (cache/validation/MDM/policy) |
| `hooks/` | 16 | Hook system (API/agent/HTTP/prompt/session/file watcher) |
| `plugins/` | 15+ | Plugin ecosystem (install/load/recommend/LSP/telemetry) |
| `mcp/` | 2 | MCP utilities (dateTime/elicitation) |
| `messages/` | 2 | Message mapping and system initialization |
| `task/` | 5 | Task framework (diskOutput/framework/formatting/SDK progress) |
| `swarm/` | 14+ | Multi-agent collaboration (backend/spawn/permission/layout) |
| `git/` | 3 | Git operations (config/filesystem/gitignore) |
| `github/` | 1 | GitHub authentication status |
| `telemetry/` | 9 | Telemetry (BigQuery/Perfetto/session tracing) |
| `teleport/` | 4 | Remote teleportation (CCR API/environment/git bundle) |
| `computerUse/` | 15 | macOS Computer Use (Swift/MCP/executor) |
| `claudeInChrome/` | 7 | Chrome native extension host |
| `deepLink/` | 6 | Deep links (protocol/terminal launcher) |
| `nativeInstaller/` | 5 | Native installation (download/PID lock/package manager) |
| `secureStorage/` | 6 | Secure storage (keychain/plainText fallback) |
| `sandbox/` | 2 | Sandbox adapters and UI tools |
| `dxt/` | 2 | DXT plugin format (helper/zip) |
| `filePersistence/` | 2 | File persistence and output scanning |
| `suggestions/` | 5 | Completion suggestions (command/directory/shell history/skill) |
| `processUserInput/` | 4 | User input processing (bash/slash/text prompt) |
| `todo/` | 1 | Todo type definitions |
| `ultraplan/` | 2 | Ultraplan (CCR session/keyword detection) |
| `memory/` | 2 | Memory types and versions |
| `skills/` | 1 | Skill change detection |
| `background/` | 1 (remote subdirectory) | Background remote tasks |

### 4.2 Key Top-Level Files

The 290 top-level files cover: authentication (auth/aws/gcp), API communication (api/apiPreconnect), configuration (config/configConstants), error handling (errors), logging (log/debug/diagLogs), encryption (crypto), context (context/contextAnalysis), cursor (Cursor), diffing (diff), formatting (format), streaming (stream/CircularBuffer), proxy (proxy/mtls), session (sessionStorage/sessionState), process (process/cleanup/cleanupRegistry), cron scheduling (cron/cronScheduler/cronTasks), and more.

---

## V. Vim Mode State Machine

### 5.1 Complete State Diagram

`vim/types.ts` defines a hierarchical state machine with two levels:

**Top Level: VimState**
```
INSERT (records insertedText for dot-repeat)
    ↕ (i/I/a/A/o/O to enter, Esc to exit)
NORMAL (nested CommandState sub-state machine)
```

**Inside NORMAL: CommandState (11 states)**

```
idle ──┬─[d/c/y]──► operator ──┬─[motion]──► execute
       ├─[1-9]────► count      ├─[0-9]────► operatorCount ──[motion]──► execute
       ├─[fFtT]───► find       ├─[ia]─────► operatorTextObj ──[wW"'(){}]──► execute
       ├─[g]──────► g          ├─[fFtT]───► operatorFind ──[char]──► execute
       ├─[r]──────► replace    └─[g]──────► operatorG ──[g/j/k]──► execute
       └─[><]─────► indent
```

### 5.2 Persistent State and Dot-Repeat

```typescript
export type PersistentState = {
  lastChange: RecordedChange | null  // 10 change types
  lastFind: { type: FindType; char: string } | null
  register: string                    // Yank register
  registerIsLinewise: boolean
}
```

`RecordedChange` supports precise replay of 10 operation types: `insert`, `operator`, `operatorTextObj`, `operatorFind`, `replace`, `x`, `toggleCase`, `indent`, `openLine`, `join`.

### 5.3 Separation of Motion and Operator

- **motions.ts**: Pure functions, input `(key, cursor, count)` output new `Cursor`. Supports `h/l/j/k`, `w/b/e/W/B/E`, `0/^/$`, `gj/gk`, `G`
- **operators.ts**: Operates on ranges (delete/change/yank). Handles special cases like `cw` (to word end rather than next word start)
- **textObjects.ts**: `findTextObject()` supports `w/W` (word), quote pairs (`"/'`), bracket pairs (`()/[]/{}/< >`) for inner/around ranges
- **transitions.ts**: Pure dispatch table, one transition function per state, returning `{ next?, execute? }`

This architecture makes every layer a pure function, making it extremely easy to test.

---

## VI. Remote Execution System

### 6.1 CCR WebSocket Connection

`SessionsWebSocket.ts` implements the WebSocket connection to the Anthropic CCR backend:

**Protocol**:
1. Connect to `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`
2. Authenticate via HTTP header (`Authorization: Bearer <token>`)
3. Receive `SDKMessage | SDKControlRequest | SDKControlResponse | SDKControlCancelRequest` stream

**Reconnection Strategy**:
- Normal disconnection: Up to 5 reconnection attempts, 2-second interval between each
- 4001 (session not found): Separate 3 retries (may temporarily 404 during compaction)
- 4003 (unauthorized): Permanent close, no reconnection
- 30-second ping interval to keep connection alive

**Runtime Compatibility**: Supports both Bun's native WebSocket and Node's `ws` package simultaneously, with code branches handling both APIs.

### 6.2 SDK Message Adapter

`sdkMessageAdapter.ts` bridges SDK-format messages sent by CCR and REPL internal message types. Handles 10+ message types:

| SDK Message Type | Conversion Result | Description |
|-------------|---------|------|
| `assistant` | `AssistantMessage` | Model response |
| `user` | `UserMessage` or ignored | Only converted when convertToolResults/convertUserTextMessages |
| `stream_event` | `StreamEvent` | Streaming partial messages |
| `result` | `SystemMessage` (errors only) | Session end signal |
| `system` (init) | `SystemMessage` | Remote session initialization |
| `system` (status) | `SystemMessage` | Compacting and other status |
| `system` (compact_boundary) | `SystemMessage` | Conversation compaction boundary |
| `tool_progress` | `SystemMessage` | Tool execution progress |
| `auth_status` | ignored | Authentication status |
| `tool_use_summary` | ignored | SDK-only event |
| `rate_limit_event` | ignored | SDK-only event |

### 6.3 RemoteSessionManager

`RemoteSessionManager.ts` coordinates three channels:
- **WebSocket subscription**: Receives messages (via `SessionsWebSocket`)
- **HTTP POST**: Sends user messages (via `sendEventToRemoteSession()`)
- **Permission requests/responses**: `pendingPermissionRequests` Map manages pending `can_use_tool` requests

### 6.4 Direct Connect Self-Hosting

The `server/` directory implements a lightweight self-hosted server mode:

- `createDirectConnectSession.ts`: POST `/sessions` creates a session, returns `{session_id, ws_url, work_dir}`
- `directConnectManager.ts`: `DirectConnectSessionManager` class communicates with the self-hosted server via WebSocket
- `types.ts`: Session state machine `starting -> running -> detached -> stopping -> stopped`, supports `SessionIndex` persistence to `~/.claude/server-sessions.json`

Difference from CCR mode: Direct Connect uses NDJSON format for bidirectional communication via WebSocket, with message formats `StdinMessage`/`StdoutMessage`; CCR uses separate HTTP POST (send) + WebSocket (receive) channels.

---

## VII. Keybinding System

### 7.1 Chord State Machine

The keybinding system supports multi-key sequences (chords), such as `ctrl+k ctrl+s`. The core is in `resolver.ts`'s `resolveKeyWithChordState()`:

**State Transitions**:

```
null (no pending) ──[key]──►
  ├─ Matches single-key binding ──► { type: 'match', action }
  ├─ Matches multi-key chord prefix ──► { type: 'chord_started', pending: [keystroke] }
  └─ No match ──► { type: 'none' }

pending: [ks1] ──[key]──►
  ├─ [ks1,ks2] fully matches chord ──► { type: 'match', action }
  ├─ [ks1,ks2] is prefix of longer chord ──► { type: 'chord_started', pending: [ks1,ks2] }
  ├─ Escape ──► { type: 'chord_cancelled' }
  └─ No match ──► { type: 'chord_cancelled' }
```

**Key Design**: Chord matching takes priority over single-key matching — if `ctrl+k` is a prefix of some chord, even if there is a standalone `ctrl+k` binding, the system enters chord waiting state. However, if all longer chords have been null-unbound, it falls back to single-key matching.

### 7.2 Context Hierarchy

18 contexts cover all UI states:

```
Global > Chat > Autocomplete > Confirmation > Help > Transcript >
HistorySearch > Task > ThemePicker > Settings > Tabs > Attachments >
Footer > MessageSelector > DiffDialog > ModelPicker > Select > Plugin
```

Each context has an independent binding block. `resolveKey()` receives an `activeContexts` array, filters by context, and applies last-wins (user overrides take priority).

### 7.3 Default Bindings Summary

`defaultBindings.ts` defines 17 context blocks with approximately 100+ default shortcuts. Platform adaptations:
- **Image paste**: Windows `alt+v`, others `ctrl+v`
- **Mode toggle**: Windows without VT mode `meta+m`, others `shift+tab`
- **Reserved shortcuts**: `ctrl+c` and `ctrl+d` use special double-press time window handling, cannot be rebound

---

## VIII. Upstream Proxy System

### 8.1 CONNECT -> WebSocket Relay Principle

`upstreamproxy/` implements an HTTP CONNECT proxy within CCR containers, tunneling to upstream proxy servers via WebSocket.

**Architecture**:

```
curl/gh/kubectl                   CCR Upstream Proxy
    ↓ HTTP CONNECT                    ↓ MITM TLS
Local TCP Relay (127.0.0.1:ephemeral)  ↔ WebSocket ↔ GKE L7 Ingress
    relay.ts                          upstreamproxy.ts
```

**Why WebSocket Instead of Native CONNECT**: The CCR ingress uses GKE L7 path-prefix routing without `connect_matcher`. WebSocket reuses the existing pattern of the session-ingress tunnel.

### 8.2 Protocol Details

1. **UpstreamProxyChunk protobuf**: Hand-encoded (avoiding protobufjs dependency), single field `bytes data = 1`, tag = 0x0a + varint length + data
2. **Layered Authentication**: WS upgrade uses `Bearer <session_token>` (ingress JWT); CONNECT header within tunnel uses `Basic <sessionId:token>` (upstream authentication)
3. **Critical Content-Type**: Must set `application/proto`, otherwise the server parses binary chunks with protojson and silently fails
4. **Security Measures**: `prctl(PR_SET_DUMPABLE, 0)` called via FFI to libc, blocking ptrace from same-UID processes (preventing prompt injection from using gdb to read tokens from the heap)

### 8.3 Initialization Flow

```
initUpstreamProxy()
  ├─ Read /run/ccr/session_token
  ├─ prctl(PR_SET_DUMPABLE, 0)
  ├─ Download CA certificate (/v1/code/upstreamproxy/ca-cert) + append to system CA bundle
  ├─ Start TCP relay (Bun.listen or Node net.createServer)
  ├─ Unlink token file (ensure relay is ready before deletion)
  └─ Export HTTPS_PROXY / SSL_CERT_FILE / NODE_EXTRA_CA_CERTS / REQUESTS_CA_BUNDLE environment variables
```

Every step is fail-open: any error only disables the proxy without blocking the session.

---

## IX. CLI / IO System

The `cli/` directory builds Claude Code's IO layer:

- **StructuredIO** (`structuredIO.ts`): Structured IO for SDK mode. Parses `StdinMessage` (JSON lines) from stdin, outputs `StdoutMessage` via `writeToStdout`. Handles `control_request`/`control_response` protocol, permission requests, elicitation
- **RemoteIO** (`remoteIO.ts`): Extends StructuredIO, adding WebSocket/SSE transport support. Connects to the Anthropic backend via `CCRClient`
- **transports/**: 6 transport implementations — `ccrClient.ts`, `HybridTransport.ts`, `SSETransport.ts`, `WebSocketTransport.ts`, `SerialBatchEventUploader.ts`, `WorkerStateUploader.ts`
- **handlers/**: 6 handlers — `agents.ts`, `auth.ts`, `autoMode.ts`, `mcp.tsx`, `plugins.ts`, `util.tsx`

---

## X. Memdir Memory System

### 10.1 Architecture Design

memdir is Claude Code's persistent memory system, implemented on top of the filesystem:

- **Directory Structure**: `~/.claude/projects/<sanitized-cwd>/memory/`
- **Entry File**: `MEMORY.md` (index, limited to 200 lines / 25KB)
- **Memory Files**: Individual `.md` files with frontmatter (name/description/type)
- **Team Directory**: `memory/team/` (shared memories, requires GrowthBook gate)
- **Log Mode**: `memory/logs/YYYY/MM/YYYY-MM-DD.md` (Kairos assistant mode)

### 10.2 Four Memory Types

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
```

- **user**: User role, preferences, knowledge background (always private)
- **feedback**: User corrections and confirmations (default private, can be team when project-level convention)
- **project**: Project context, deadlines, decisions (tends toward team)
- **reference**: External system pointers (usually team)

### 10.3 Intelligent Recall

`findRelevantMemories.ts` uses a Sonnet side-query to select relevant memories from the memory store (up to 5):
1. `scanMemoryFiles()` scans the directory, reads frontmatter headers
2. `selectRelevantMemories()` sends the list + user query to Sonnet, using JSON schema output
3. Returns relevant file paths + mtime (used for freshness annotation)

### 10.4 Path Security

`teamMemPaths.ts` implements multi-layered defenses:
- `sanitizePathKey()`: Rejects null bytes, URL-encoded traversal, Unicode NFKC normalization attacks, backslashes, absolute paths
- `validateTeamMemWritePath()`: Two-pass check — `path.resolve()` string-level + `realpathDeepestExisting()` symlink resolution
- `isRealPathWithinTeamDir()`: Requires realpath prefix match + separator protection (prevents `/foo/team-evil` from matching `/foo/team`)
- Dangling symlink detection: `lstat()` distinguishes between truly non-existent vs. symlink target missing

---

## XI. Inter-Module Dependency Topology

```
                       ┌──────────────┐
                       │  state/store │ (35-line core)
                       └──────┬───────┘
                              │ onChange
                    ┌─────────▼──────────┐
                    │ onChangeAppState   │ (side effect hub)
                    └──┬──────┬──────┬───┘
                       │      │      │
              ┌────────▼┐ ┌──▼───┐ ┌▼────────┐
              │settings  │ │CCR   │ │config   │
              │persist   │ │sync  │ │persist  │
              └──────────┘ └──────┘ └─────────┘

   tasks/ ◄──── Task.ts ◄──── tasks.ts (registry)
     │              │
     │         ┌────▼────┐
     └────────►│AppState │◄──── remote/ (CCR/DirectConnect)
               │ .tasks  │
               └─────────┘
                    │
            ┌───────▼────────┐
            │ keybindings/   │ (context-aware input dispatch)
            │ resolver.ts    │
            └────────────────┘
                    │
            ┌───────▼────────┐
            │ cli/ (IO layer)│
            │ StructuredIO   │◄──── upstreamproxy/ (CONNECT relay)
            │ RemoteIO       │
            └────────────────┘
                    │
            ┌───────▼────────┐
            │ vim/ (editor)  │◄──── utils/Cursor.ts
            │ transitions.ts │
            └────────────────┘
```

---

## Summary

Claude Code's infrastructure modules demonstrate several consistent design principles:

1. **Minimal Core + External Extension**: 35-line Store, pure function vim transitions, declarative keybinding configuration
2. **Defense in Depth for Security**: memdir's 4-layer path validation, upstreamproxy's prctl + token lifecycle management, symlink-safe task IDs
3. **Fail-Open**: Every step of the upstream proxy disables the feature on error without blocking the session; migration scripts are designed for idempotency
4. **Runtime Compatibility**: WebSocket supports both Bun/Node simultaneously; feature gates load task types on demand
5. **Centralized Side Effect Management**: `onChangeAppState` serves as the single point for state change side effects, replacing 8+ scattered notification paths
