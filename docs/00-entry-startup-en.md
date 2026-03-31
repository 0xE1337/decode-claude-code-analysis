# 00 - Entry Point and Startup Optimization (In-Depth Analysis)

## Overview

Claude Code's startup system employs a carefully designed multi-layer entry architecture. From the moment a user types the `claude` command to entering the main interaction loop, it passes through four major stages: cli.tsx -> main.tsx -> init.ts -> setup.ts. The core design philosophy of the entire startup path is: **defer loading as much as possible, execute in parallel as much as possible, minimize blocking as much as possible**.

The system compresses startup time to the extreme through various optimization techniques: module top-level side-effect prefetching (MDM configuration, Keychain reads), Commander preAction hook deferred initialization, parallel execution of setup() and command loading, and post-render deferred prefetching (startDeferredPrefetches). The `--bare` mode serves as a minimal startup path, skipping nearly all non-core warm-up and background tasks.

bootstrap/state.ts acts as a global state container, completing initialization at module load time. It is one of the first modules to become ready in the entire system, providing foundational state support for all subsequent subsystems.

---

## I. In-Depth File-by-File, Function-by-Function Analysis

### 1.1 entrypoints/cli.tsx — Startup Dispatcher

**File Role**: The true entry point of the program. The core strategy is "fast path first" — intercept and handle special commands as early as possible to avoid loading the full main.tsx module tree.

#### 1.1.1 Top-Level Side-Effect Zone (Lines 1-26)

```typescript
// cli.tsx:5 — Fix corepack auto-pin Bug
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// cli.tsx:9-13 — CCR (Claude Code Remote) environment heap size setting
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}

// cli.tsx:21-26 — Ablation baseline experiment
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', ...]) {
    process.env[k] ??= '1';
  }
}
```

**Line-by-Line Analysis**:

- **COREPACK_ENABLE_AUTO_PIN** (Line 5): This is a bug fix. Corepack automatically modifies the user's `package.json` to add yarnpkg, which is an unacceptable side effect for a CLI tool. The comment explicitly labels this as a "Bugfix".
- **NODE_OPTIONS Heap Size** (Lines 9-13): CCR containers are allocated 16GB of memory, but Node.js's default heap limit is far lower. Setting 8192MB ensures child processes don't crash due to out-of-memory errors. Note that it **appends** rather than overwrites existing NODE_OPTIONS, respecting the user's custom configuration.
- **Ablation Baseline Experiment** (Lines 21-26): This is an internal Anthropic A/B testing mechanism used to measure the impact of individual features on overall performance. `feature('ABLATION_BASELINE')` is evaluated at build time, and in external builds the entire if block is eliminated by DCE. Using `??=` instead of `=` ensures the experiment only sets default values without overriding manual configurations.

**Design Trade-off**: Top-level side effects violate the usual "pure module" principle, but for environment variables that need to be set before any import, this is the only correct location. The code explicitly marks this intentional violation with `eslint-disable` comments.

#### 1.1.2 main() Fast Path Dispatch (Lines 33-298)

The `main()` function is a carefully designed command dispatcher. It checks `process.argv` and matches the following fast paths by priority:

| Priority | Command/Argument | Handling Method | Module Load Volume | Latency |
|----------|-----------------|-----------------|-------------------|---------|
| 1 | `--version` / `-v` / `-V` | Direct output of MACRO.VERSION | Zero imports | <1ms |
| 2 | `--dump-system-prompt` | enableConfigs + getSystemPrompt | Minimal | ~20ms |
| 3 | `--claude-in-chrome-mcp` | Start Chrome MCP server | Dedicated module | Varies |
| 4 | `--chrome-native-host` | Start Chrome Native Host | Dedicated module | Varies |
| 5 | `--computer-use-mcp` | Start Computer Use MCP | Dedicated module (CHICAGO_MCP gated) | Varies |
| 6 | `--daemon-worker` | Daemon worker | Minimal (no enableConfigs) | <5ms |
| 7 | `remote-control`/`rc`/... | Bridge remote control | Bridge module | ~50ms |
| 8 | `daemon` | Daemon main entry | Daemon module | ~30ms |
| 9 | `ps`/`logs`/`attach`/`kill`/`--bg` | Background session management | bg.js | ~30ms |
| 10 | `new`/`list`/`reply` | Template jobs | templateJobs | ~30ms |
| 11 | `--worktree --tmux` | Tmux worktree fast path | Worktree module | ~10ms |

**Key Design Details**:

```typescript
// cli.tsx:37-42 — Zero-dependency fast path for --version
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
  console.log(`${MACRO.VERSION} (Claude Code)`);
  return;  // No imports whatsoever, fastest possible return
}
```

`MACRO.VERSION` is a build-time inlined constant, so the `--version` path requires no `import()` calls — making it the fastest of all paths. The `args.length === 1` check ensures `claude --version --debug` doesn't accidentally enter this path.

```typescript
// cli.tsx:96-106 — Minimal path for daemon-worker
// The comment explicitly states: No enableConfigs(), no analytics sinks at this layer —
// workers are lean. If a worker kind needs configs/auth, it calls them inside its run() fn.
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
  await runDaemonWorker(args[1]);
  return;
}
```

The `--daemon-worker` path is the ultimate embodiment of the "defer until needed" principle — even something as fundamental as `enableConfigs()` initialization is pushed into the worker for on-demand invocation.

#### 1.1.3 Entering the Full Startup Path (Lines 287-298)

```typescript
// cli.tsx:288-298 — Load full CLI
const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
startCapturingEarlyInput();  // Capture user keystrokes during main.tsx module evaluation
profileCheckpoint('cli_before_main_import');
const { main: cliMain } = await import('../main.js');  // Triggers ~135ms of module evaluation
profileCheckpoint('cli_after_main_import');
await cliMain();
```

**Timing Significance of `startCapturingEarlyInput()`**: This call executes before `import('../main.js')`. The import of `main.js` triggers approximately 135ms of module evaluation chain (200+ lines of static imports), during which the user may have already started typing. The `earlyInput` module buffers keystroke events during this period, ensuring the user's input is not lost. This is a meticulous consideration for user experience.

**`--bare` Setup in cli.tsx** (Lines 282-285):

```typescript
if (args.includes('--bare')) {
  process.env.CLAUDE_CODE_SIMPLE = '1';
}
```

Note that `--bare`'s environment variable is set at the cli.tsx layer, before main.tsx is loaded. This ensures `isBareMode()` returns the correct value when evaluated at module top-level, causing side effects like `startKeychainPrefetch()` to be skipped in bare mode.

---

### 1.2 main.tsx — Core Startup Engine (4683 Lines)

This is the largest and most complex file in the entire system. It simultaneously plays three roles: **module dependency graph root node**, **Commander CLI definition**, and **initialization flow orchestrator**.

#### 1.2.1 Top-Level Triple Prefetch (Lines 1-20)

```typescript
// main.tsx:1-8 — Comments explaining ordering requirements
// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query)
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API key)

import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');                    // [1] Mark entry timestamp

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();                                      // [2] Start MDM subprocess

import { ensureKeychainPrefetchCompleted, startKeychainPrefetch }
  from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();                                // [3] Start Keychain prefetch
```

**Function-Level Analysis**:

**`startMdmRawRead()`** (rawRead.ts:120-123):
- **Input**: No parameters
- **Output**: Sets the module-level variable `rawReadPromise`
- **Side Effects**: On macOS, spawns a `plutil` subprocess to read MDM plist configuration; on Windows, spawns `reg query` to read the registry
- **Idempotency**: Internal guard `if (rawReadPromise) return` ensures it only executes once
- **Blocking**: **Non-blocking**. `execFile()` is asynchronous and returns immediately. The subprocess runs in the background
- **Performance Detail**: In rawRead.ts:64-69 there is an important fast path — for each plist path, it first uses **synchronous** `existsSync()` to check if the file exists. The comment explains why a synchronous call is used: `Uses synchronous existsSync to preserve the spawn-during-imports invariant: execFilePromise must be the first await so plutil spawns before the event loop polls`. On non-MDM machines, the plist file doesn't exist, `existsSync` skips the plutil subprocess spawn (~5ms each), and directly returns an empty result

**`startKeychainPrefetch()`** (keychainPrefetch.ts:69-89):
- **Input**: No parameters
- **Output**: Sets the module-level variable `prefetchPromise`
- **Side Effects**: On macOS, spawns two parallel `security find-generic-password` subprocesses: (a) OAuth credentials ~32ms; (b) legacy API Key ~33ms. No-op on non-darwin platforms
- **Key Detail**: Timeout handling. In keychainPrefetch.ts:54-59, if the subprocess times out (`err.killed`), the result is **not** written to cache — allowing the subsequent synchronous path to retry. This prevents a subtle bug: the keychain might have a key, but the subprocess timeout causes `null` to be cached, and the subsequent `getApiKeyFromConfigOrMacOSKeychain()` reads the cache and concludes there is no key
- **`isBareMode()` Guard** (Line 70): Bare mode skips keychain reading. The comment explains the reason: in `--bare` mode, authentication is strictly limited to ANTHROPIC_API_KEY or apiKeyHelper; OAuth and keychain are never read

**Why does the comment say "~65ms on every macOS startup"?** keychainPrefetch.ts:8-9 explains: `isRemoteManagedSettingsEligible() reads two separate keychain entries SEQUENTIALLY via sync execSync`. Without prefetching, the two keychain reads would be executed serially in `applySafeConfigEnvironmentVariables()`. Through parallel prefetching, these 65ms are hidden within the import evaluation time.

#### 1.2.2 Static Import Zone (Lines 21-200)

Approximately 180 lines of static import statements, evaluating in approximately 135ms. These imports have several key characteristics:

**Lazy require to Break Circular Dependencies** (Lines 68-73):

```typescript
// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () =>
  require('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () =>
  require('./utils/swarm/backends/teammateModeSnapshot.js');
```

**Analysis**: These three lazy requires are all related to Agent Swarm (team collaboration). The circular dependency chain is `teammate.ts -> AppState.tsx -> ... -> main.tsx`. Using lazy require instead of top-level import means:
1. Modules are only evaluated upon first invocation
2. At that point, other modules in the circular dependency chain have already completed initialization
3. The return type maintains type safety through `as typeof import(...)`

**Conditional require and DCE (Dead Code Elimination)** (Lines 74-81):

```typescript
// Dead code elimination: conditional import for COORDINATOR_MODE
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js') : null;

// Dead code elimination: conditional import for KAIROS (assistant mode)
const assistantModule = feature('KAIROS')
  ? require('./assistant/index.js') : null;
const kairosGate = feature('KAIROS')
  ? require('./assistant/gate.js') : null;
```

**Design Trade-off**: `feature()` comes from `bun:bundle` and is evaluated at build time to `true` or `false`. When the feature flag is `false`, the `require` branch of the ternary expression is treated as dead code, and Bun's bundler completely eliminates it from the final artifact. This is more thorough than runtime conditional imports — not only is the module not loaded, the module file itself doesn't exist in the bundle.

**`autoModeStateModule`** (Line 171): Same pattern, but located at the end of the import zone:

```typescript
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? require('./utils/permissions/autoModeState.js') : null;
```

This module only exists when the TRANSCRIPT_CLASSIFIER feature is enabled, used for auto mode classifier state management.

**Import End Marker** (Line 209):

```typescript
profileCheckpoint('main_tsx_imports_loaded');
```

This checkpoint precisely marks the time when all static import evaluations complete. Combined with `main_tsx_entry`, it allows calculating the exact import evaluation duration (i.e., the `import_time` phase).

#### 1.2.3 Anti-Debugging Protection (Lines 231-271)

```typescript
function isBeingDebugged() {
  const isBun = isRunningWithBun();
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // Bun has a bug: in single-file executables, process.argv arguments leak into process.execArgv
      // Therefore only check --inspect series, skip legacy --debug
      return /--inspect(-brk)?/.test(arg);
    } else {
      // Node.js checks both --inspect and legacy --debug flag families
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });
  const hasInspectEnv = process.env.NODE_OPTIONS &&
    /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);
  try {
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    return hasInspectArg || hasInspectEnv;
  }
}

// External builds prohibit debugging
if ("external" !== 'ant' && isBeingDebugged()) {
  process.exit(1);  // Silent exit, no error message
}
```

**Three-Layer Detection**:
1. **execArgv Argument Detection**: Distinguishes between Bun and Node.js inspect flag formats
2. **NODE_OPTIONS Environment Variable Detection**: Catches debug flags injected via environment variables
3. **inspector Module Runtime Detection**: Checks if the inspector URL is already active (covers cases where debugging is enabled through code)

**Design Trade-off**: `"external" !== 'ant'` is a build-time string replacement. In internal builds, `"external"` is replaced with `'ant'`, the condition is always `false`, and the entire detection is skipped. In external builds, it remains as `"external"`, the condition is `true`, and debugging is prohibited. This is a reverse engineering protection measure — silent exit (outputting no information) increases reverse engineering difficulty.

**Bun Compatibility Note**: The code documents a known Bun bug (similar to oven-sh/bun#11673) — in single-file executables, application arguments leak into `process.execArgv`. This causes false positives if legacy `--debug` flags are checked. The solution is for the Bun path to only check the `--inspect` series.

#### 1.2.4 Helper Function Zone (Lines 211-584)

**`logManagedSettings()`** (Lines 216-229):
- Reports the key list of enterprise managed settings to Statsig analytics
- Wrapped in try-catch, silently ignoring errors — "this is just for analytics"
- Called after init() completes, ensuring the settings system is loaded

**`logSessionTelemetry()`** (Lines 279-290):
- Reports telemetry data for skills and plugins
- Called from both the interactive path and the non-interactive (-p) path
- Internal comment explains why two call sites are needed: `both go through main.tsx but branch before the interactive startup path`

**`runMigrations()`** (Lines 326-352):

```typescript
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    // ... 11 synchronous migrations total
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION
      ? prev : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION });
  }
  // Asynchronous migration — fire and forget
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}
```

**Design Details**:
- The version number mechanism prevents migrations from running repeatedly
- `saveGlobalConfig` uses a CAS (Compare-And-Swap) pattern: only writes when the version doesn't match
- The asynchronous migration `migrateChangelogFromConfig()` is independent of the version check, silently retrying on failure
- The `@[MODEL LAUNCH]` comment reminds developers to consider string migration needs when releasing new models

**`prefetchSystemContextIfSafe()`** (Lines 360-380):

```typescript
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();
  if (isNonInteractiveSession) {
    void getSystemContext();  // -p mode implies trust
    return;
  }
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    void getSystemContext();  // Trust already established
  }
  // Otherwise don't prefetch — wait for trust to be established
}
```

**Security Boundary Analysis**: This function embodies the system's trust model. `getSystemContext()` internally executes `git status`, `git log`, and similar commands, and git can execute arbitrary code through `core.fsmonitor`, `diff.external`, and other configurations. Therefore:
- **Non-interactive mode** (-p): Trust is implied, prefetch directly. Help documentation explicitly states this premise
- **Interactive mode**: Must check whether the trust dialog has been accepted
- **First run**: No prefetch, wait for the user to confirm in the trust dialog

**`startDeferredPrefetches()`** (Lines 388-431):

```typescript
export function startDeferredPrefetches(): void {
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) || isBareMode()) {
    return;
  }

  void initUser();                          // User info
  void getUserContext();                    // CLAUDE.md and other context
  prefetchSystemContextIfSafe();            // git status/log
  void getRelevantTips();                   // Tip information

  // Cloud provider credential prefetch (conditional)
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }

  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);  // File count
  void initializeAnalyticsGates();          // Analytics gates
  void prefetchOfficialMcpUrls();           // Official MCP URLs
  void refreshModelCapabilities();          // Model capabilities

  void settingsChangeDetector.initialize(); // Settings change detection
  void skillChangeDetector.initialize();    // Skill change detection

  // Internal builds only: event loop stall detector
  if ("external" === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}
```

**Performance Philosophy Analysis**:

The comments for this function describe its design intent with extreme precision:

1. `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` guard: Used for performance benchmarking. During startup performance testing, these prefetches produce CPU and event loop contention, affecting measurement accuracy
2. `--bare` guard: `These are cache-warms for the REPL's first-turn responsiveness... Scripted -p calls don't have a "user is typing" window to hide this work in`
3. `AbortSignal.timeout(3000)` for file counting: Force abort after 3 seconds, preventing file counting in large repositories from blocking too long
4. The event loop stall detector only runs in internal builds, with a threshold >500ms

**`loadSettingsFromFlag()`** (Lines 432-483) — Prompt Cache Friendly Design:

```typescript
// Use a content-hash-based path instead of random UUID to avoid
// busting the Anthropic API prompt cache. The settings path ends up
// in the Bash tool's sandbox denyWithinAllow list, which is part of
// the tool description sent to the API. A random UUID per subprocess
// changes the tool description on every query() call, invalidating
// the cache prefix and causing a 12x input token cost penalty.
settingsPath = generateTempFilePath('claude-settings', '.json', {
  contentHash: trimmedSettings
});
```

**This is an ingenious performance optimization**. The problem chain:
1. The temporary file path passed via `--settings` appears in the Bash tool's sandbox description
2. The sandbox description is part of the tool definition, sent to the API
3. The API's prompt cache is based on prefix matching
4. Random UUID path -> different path on every `query()` call -> different tool definition -> prompt cache invalidation
5. Cache invalidation means 12x input token cost

The solution is to use a content hash instead of a random UUID — the same settings content generates the same path, maintaining consistency across process boundaries.

#### 1.2.5 main() Function (Lines 585-856)

**Function Signature**: `export async function main()`
- **Input**: None (reads from `process.argv`)
- **Output**: None (sets global state, eventually calls `run()`)
- **Side Effects**:
  1. Sets `NoDefaultCurrentDirectoryInExePath` (Windows security protection)
  2. Registers SIGINT and exit handlers
  3. Parses and rewrites `process.argv` (cc://, assistant, ssh subcommands)
  4. Determines interactivity and client type
  5. Eagerly loads settings

**Windows PATH Hijacking Protection** (Lines 590-591):

```typescript
process.env.NoDefaultCurrentDirectoryInExePath = '1';
```

The comment for this line references Microsoft documentation. On Windows, `SearchPathW` searches the current directory by default, allowing attackers to place a malicious executable with the same name in the current directory. Setting this environment variable disables this behavior.

**Subtle Design of the SIGINT Handler** (Lines 598-606):

```typescript
process.on('SIGINT', () => {
  // In print mode, print.ts registers its own SIGINT handler that aborts
  // the in-flight query and calls gracefulShutdown; skip here to avoid
  // preempting it with a synchronous process.exit().
  if (process.argv.includes('-p') || process.argv.includes('--print')) {
    return;
  }
  process.exit(0);
});
```

Print mode has its own SIGINT handler (which aborts the API request and exits gracefully); this handler must yield. If both handlers call `process.exit()`, a race condition would occur.

**cc:// URL Rewriting** (Lines 612-642):

This code shows how to support protocol URLs without introducing subcommands. The core strategy is **rewriting argv**:
- Interactive mode: Strips the `cc://` URL from argv, stores it in the `_pendingConnect` object, and lets the main command path handle it
- Non-interactive mode (-p): Rewrites to the internal `open` subcommand

The advantage of this rewriting strategy is reusing the entire interactive TUI stack, avoiding the need to create a completely independent code path for cc://.

**Interactivity Detection** (Lines 798-808):

```typescript
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
const hasInitOnlyFlag = cliArgs.includes('--init-only');
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
```

Logical OR of four conditions: -p flag, --init-only flag, SDK URL mode, and non-TTY output. Note that `!process.stdout.isTTY` is the final fallback — even without any flags, if stdout is not a terminal (pipe/file redirect), it's treated as non-interactive.

#### 1.2.6 run() and Commander preAction (Lines 884-967)

**Commander Initialization** (Lines 884-903):

```typescript
function createSortedHelpConfig() {
  const getOptionSortKey = (opt: Option): string =>
    opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
  return Object.assign(
    { sortSubcommands: true, sortOptions: true } as const,
    { compareOptions: (a: Option, b: Option) =>
      getOptionSortKey(a).localeCompare(getOptionSortKey(b)) }
  );
}
```

The reason for `Object.assign` is explained in the comment: `Commander supports compareOptions at runtime but @commander-js/extra-typings doesn't include it in the type definitions`. This is a workaround for insufficient TypeScript type coverage.

**preAction Hook — Core Initialization Orchestrator** (Lines 907-967):

```typescript
program.hook('preAction', async thisCommand => {
  profileCheckpoint('preAction_start');

  // [1] Wait for module top-level prefetches to complete (nearly zero cost)
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
  profileCheckpoint('preAction_after_mdm');

  // [2] Core initialization
  await init();
  profileCheckpoint('preAction_after_init');

  // [3] Set terminal title
  if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
    process.title = 'claude';
  }

  // [4] Attach log sinks
  const { initSinks } = await import('./utils/sinks.js');
  initSinks();

  // [5] Handle --plugin-dir
  const pluginDir = thisCommand.getOptionValue('pluginDir');
  if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
    setInlinePlugins(pluginDir);
    clearPluginCache('preAction: --plugin-dir inline plugins');
  }

  // [6] Run data migrations
  runMigrations();

  // [7] Remote managed settings and policy loading (non-blocking)
  void loadRemoteManagedSettings();
  void loadPolicyLimits();

  // [8] Settings sync upload (non-blocking)
  if (feature('UPLOAD_USER_SETTINGS')) {
    void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
  }
});
```

**Why use a preAction hook instead of direct invocation?**

The comment explicitly states: `Use preAction hook to run initialization only when executing a command, not when displaying help`. When the user runs `claude --help`, Commander directly outputs help text without triggering preAction, avoiding unnecessary initialization overhead (init(), data migrations, etc.). This saves approximately 100ms on the common "display help" operation.

**Timing Analysis of Step [1]**:

```typescript
// Nearly free — subprocesses complete during the ~135ms of imports above.
// Must resolve before init() which triggers the first settings read
// (applySafeConfigEnvironmentVariables -> getSettingsForSource('policySettings')
// -> isRemoteManagedSettingsEligible -> sync keychain reads otherwise ~65ms).
await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
```

The timing reasoning in the comment is worth careful analysis:
1. MDM and Keychain subprocesses are started at main.tsx lines 16 and 20
2. The subsequent ~135ms of import evaluation provides ample parallel window
3. At this point the await completes almost immediately (subprocesses already finished during imports)
4. **Critical dependency**: Must complete before `init()`, because `init()`'s `applySafeConfigEnvironmentVariables()` calls `isRemoteManagedSettingsEligible()`, which performs synchronous keychain reads (~65ms) if the cache is not hit

**Handling History of --plugin-dir in Step [5]**:

The comment references `gh-33508`, explaining why `--plugin-dir` is handled in preAction:
- `--plugin-dir` is a top-level program option
- Subcommands (`plugin list`, `mcp *`) have independent action handlers that can't see this option
- It must be set up early in preAction to ensure `getInlinePlugins()` is available across all code paths

**Print Mode Skips Subcommand Registration Optimization** (Lines 3875-3890):

```typescript
// -p/--print mode: skip subcommand registration. The 52 subcommands
// (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
// never dispatched in print mode — commander routes the prompt to the
// default action. The subcommand registration path was measured at ~65ms
// on baseline — mostly the isBridgeEnabled() call (25ms settings Zod parse
// + 40ms sync keychain subprocess)
const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
if (isPrintMode && !isCcUrl) {
  await program.parseAsync(process.argv);
  return program;
}
```

This code demonstrates an optimization based on measured data: the registration path for 52 subcommands takes approximately 65ms, of which 25ms is settings Zod parsing and 40ms is the synchronous keychain subprocess. Print mode never dispatches to these subcommands (Commander routes the prompt to the default action), so they are skipped entirely.

#### 1.2.7 Action Handler — Main Flow Launch (Starting at Line 1007)

This is the longest function in main.tsx (approximately 2800 lines), handling all CLI options and preparing the runtime environment.

**Parallel Execution of setup() and Command Loading** (Lines 1913-1934):

```typescript
// Register bundled skills/plugins before kicking getCommands() — they're
// pure in-memory array pushes (<1ms, zero I/O) that getBundledSkills()
// reads synchronously. Previously ran inside setup() after ~20ms of
// await points, so the parallel getCommands() memoized an empty list.
if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
  initBuiltinPlugins();
  initBundledSkills();
}

const setupPromise = setup(preSetupCwd, permissionMode, ...);
const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);

// Suppress transient unhandledRejection
commandsPromise?.catch(() => {});
agentDefsPromise?.catch(() => {});
await setupPromise;

const [commands, agentDefinitions] = await Promise.all([
  commandsPromise ?? getCommands(currentCwd),
  agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
]);
```

**Archaeology of a Race Condition Fix**:

The comment documents a real race condition that actually occurred, worth dissecting step by step:

1. **Original code**: `initBundledSkills()` was executed inside `setup()`
2. **setup() structure**: Started with `await startUdsMessaging()` (~20ms socket binding)
3. **Problem**: setup()'s await yields control -> `getCommands()`'s microtask executes first -> calls `getBundledSkills()` -> returns empty array (because `initBundledSkills()` hasn't executed yet) -> result is memoize-cached -> all subsequent calls return an empty list
4. **Fix**: Move `initBuiltinPlugins()` and `initBundledSkills()` before the `setup()` call; they are pure in-memory operations (<1ms, zero I/O) that don't block

**Meaning of `.catch(() => {})`**: This is not ignoring errors, but preventing Node.js's `unhandledRejection` from firing during `setupPromise`'s ~28ms await. The final `Promise.all` still observes these rejections.

**Worktree Mode Guard**: `commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)`. When `--worktree` is enabled, `setup()` may execute `process.chdir()` (setup.ts:271), so the pre-setup cwd can't be used to pre-start command loading. The null branch reloads with the correct cwd after setup completes.

---

### 1.3 entrypoints/init.ts — Core Initialization

#### 1.3.1 init() — Memoize-Wrapped One-Time Initialization

```typescript
export const init = memoize(async (): Promise<void> => {
  // ...
});
```

**Why use memoize?** init() may be called from multiple paths (preAction hook, subcommand handlers, SDK entry points, etc.). Memoize ensures it executes only once, with subsequent calls directly returning the cached Promise.

**In-Depth Execution Flow Analysis**:

**Phase A — Configuration and Environment Variables** (Lines 62-84):

```typescript
enableConfigs();                          // [A1] Validate and enable config system
applySafeConfigEnvironmentVariables();    // [A2] Only apply safe environment variables
applyExtraCACertsFromConfig();            // [A3] CA certificates (must precede first TLS handshake)
```

- `enableConfigs()` validates the format and integrity of all configuration files. If a `ConfigParseError` is found, in non-interactive mode it outputs an error to stderr and exits; in interactive mode it dynamically imports `InvalidConfigDialog` to display a repair interface. Note the comment: `showInvalidConfigDialog is dynamically imported in the error path to avoid loading React at init`
- `applySafeConfigEnvironmentVariables()` only applies variables that are "safe before trust". The full `applyConfigEnvironmentVariables()` (including dangerous variables like LD_PRELOAD, PATH) waits until trust is established
- `applyExtraCACertsFromConfig()` must execute before any TLS connection. The comment specifically mentions Bun's behavior: `Bun caches the TLS cert store at boot via BoringSSL, so this must happen before the first TLS handshake`

**Phase B — Async Background Task Fire** (Lines 94-118):

```typescript
// [B1] First-party event logging initialization
void Promise.all([
  import('../services/analytics/firstPartyEventLogger.js'),
  import('../services/analytics/growthbook.js'),
]).then(([fp, gb]) => {
  fp.initialize1PEventLogging();
  gb.onGrowthBookRefresh(() => {
    void fp.reinitialize1PEventLoggingIfConfigChanged();
  });
});

// [B2] OAuth account info population
void populateOAuthAccountInfoIfNeeded();

// [B3] JetBrains IDE detection
void initJetBrainsDetection();

// [B4] GitHub repository detection
void detectCurrentRepository();
```

All calls prefixed with `void` are "fire-and-forget" — they start async tasks without waiting for completion. The results of these tasks are consumed through global caches when needed later.

**The Subtle Design of B1**: Uses `Promise.all` to load firstPartyEventLogger and growthbook modules in parallel, then establishes the `onGrowthBookRefresh` callback chain. The comment explains: `growthbook.js is already in the module cache by this point (firstPartyEventLogger imports it)` — meaning growthbook's module was actually loaded during firstPartyEventLogger's import process, so the `import` here only fetches a reference with zero additional overhead.

**Phase C — Network Configuration and Pre-connection** (Lines 134-159):

```typescript
configureGlobalMTLS();         // [C1] mTLS certificate configuration
configureGlobalAgents();       // [C2] HTTP proxy configuration
preconnectAnthropicApi();      // [C3] TCP+TLS pre-connection

// CCR environment only: initialize upstream proxy relay
if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
  try {
    const { initUpstreamProxy, getUpstreamProxyEnv } = await import('../upstreamproxy/upstreamproxy.js');
    const { registerUpstreamProxyEnvFn } = await import('../utils/subprocessEnv.js');
    registerUpstreamProxyEnvFn(getUpstreamProxyEnv);
    await initUpstreamProxy();
  } catch (err) {
    logForDebugging(`[init] upstreamproxy init failed: ${err}; continuing without proxy`, { level: 'warn' });
  }
}
```

**Precise Timing Requirements of `preconnectAnthropicApi()`**:

The comment is very detailed:

> Preconnect to the Anthropic API -- overlap TCP+TLS handshake (~100-200ms) with the ~100ms of action-handler work before the API request. After CA certs + proxy agents are configured so the warmed connection uses the right transport. Fire-and-forget; skipped for proxy/mTLS/unix/cloud-provider where the SDK's dispatcher wouldn't reuse the global pool.

There are three key constraints here:
1. **Timing**: Must come after CA certificate and proxy configuration (otherwise the connection uses the wrong transport layer)
2. **Parallel window**: Uses the approximately 100ms of work time in the subsequent action handler to hide the 100-200ms TCP+TLS handshake
3. **Applicability**: Only effective in direct-connection mode. In proxy/mTLS/Unix socket/cloud provider modes, the SDK uses its own dispatcher and won't reuse the global connection pool

**Fail-Open Design of Upstream Proxy Relay**: The proxy initialization in the CCR environment is wrapped in try-catch, logging only a warning on failure and continuing. This is a fault-tolerant design — proxy failure should not prevent the entire CLI from starting.

#### 1.3.2 initializeTelemetryAfterTrust() — Post-Trust Telemetry Initialization

```typescript
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // Special path: SDK/headless + beta tracing → early initialization
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(/*...*/);
    }
    // Normal path: wait for remote settings to load before initializing
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        applyConfigEnvironmentVariables();
        await doInitializeTelemetry();
      })
      .catch(/*...*/);
  } else {
    void doInitializeTelemetry().catch(/*...*/);
  }
}
```

**Dual-Layer Initialization Logic**: For users with remote managed settings, telemetry initialization needs to wait for remote settings to arrive (because remote settings may contain OTEL endpoint configuration). However, the SDK + beta tracing path needs immediate initialization to ensure the tracer is ready before the first query. `doInitializeTelemetry()` internally uses a `telemetryInitialized` boolean flag to prevent double initialization.

#### 1.3.3 setMeterState() — Telemetry Lazy Loading

```typescript
async function setMeterState(): Promise<void> {
  // Lazy-load instrumentation to defer ~400KB of OpenTelemetry + protobuf
  const { initializeTelemetry } = await import('../utils/telemetry/instrumentation.js');
  const meter = await initializeTelemetry();
  // ...
}
```

OpenTelemetry (~400KB) + protobuf + gRPC exporters (~700KB via @grpc/grpc-js) total over 1MB. Deferring loading until telemetry is actually initialized is a significant startup optimization.

---

### 1.4 setup.ts — Session-Level Initialization (477 Lines)

#### 1.4.1 Function Signature and Parameter Analysis

```typescript
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void>
```

9 parameters covering all variants of session initialization: base path, permission mode, worktree configuration, tmux configuration, custom session ID, PR number, and messaging socket path.

#### 1.4.2 UDS Messaging Service Startup (Lines 89-102)

```typescript
if (!isBareMode() || messagingSocketPath !== undefined) {
  if (feature('UDS_INBOX')) {
    const m = await import('./utils/udsMessaging.js')
    await m.startUdsMessaging(
      messagingSocketPath ?? m.getDefaultUdsSocketPath(),
      { isExplicit: messagingSocketPath !== undefined },
    )
  }
}
```

**Design Details**:
- Skipped by default in bare mode, but `messagingSocketPath !== undefined` serves as an escape hatch — the comment references `#23222 gate pattern`
- The `await` is necessary: after socket binding, `$CLAUDE_CODE_MESSAGING_SOCKET` is exported to `process.env`, and subsequent hooks (especially SessionStart) may spawn child processes that inherit this environment variable
- This await accounts for ~20ms of setup()'s ~28ms total

#### 1.4.3 setCwd() and Hooks Snapshot Timing Dependency (Lines 160-168)

```typescript
// IMPORTANT: setCwd() must be called before any other code that depends on the cwd
setCwd(cwd)

// Capture hooks configuration snapshot to avoid hidden hook modifications.
// IMPORTANT: Must be called AFTER setCwd() so hooks are loaded from the correct directory
const hooksStart = Date.now()
captureHooksConfigSnapshot()
```

Two `IMPORTANT` comments define a strict timing dependency:
1. `setCwd()` must execute first — it sets the working directory, affecting all subsequent file path resolution
2. `captureHooksConfigSnapshot()` must come after `setCwd()` — hooks configuration files are located in the project directory

#### 1.4.4 Worktree Handling (Lines 176-285)

This is the most complex branch in setup(). Key design decisions:

```typescript
// IMPORTANT: this must be called before getCommands(), otherwise /eject won't be available.
if (worktreeEnabled) {
  const hasHook = hasWorktreeCreateHook()
  const inGit = await getIsGit()
  if (!hasHook && !inGit) {
    // Error exit
  }

  // findCanonicalGitRoot is sync/filesystem-only/memoized; the underlying
  // findGitRoot cache was already warmed by getIsGit() above, so this is ~free.
  const mainRepoRoot = findCanonicalGitRoot(getCwd())
```

The "~free" in the comment explains the cache warming chain: `getIsGit()` internally calls `findGitRoot()`, whose result is memoize-cached; subsequently `findCanonicalGitRoot()` reuses the same cache.

The setup chain after worktree creation (Lines 271-285) also demonstrates timing sensitivity:

```typescript
process.chdir(worktreeSession.worktreePath)
setCwd(worktreeSession.worktreePath)
setOriginalCwd(getCwd())
setProjectRoot(getCwd())
saveWorktreeState(worktreeSession)
clearMemoryFileCaches()          // Clear old cwd's CLAUDE.md cache
updateHooksConfigSnapshot()       // Re-read hooks config from new directory
```

#### 1.4.5 Background Tasks and Prefetch Pipeline (Lines 287-394)

**Critical Placement of the tengu_started Beacon** (Lines 371-378):

```typescript
initSinks() // Attach error log + analytics sinks

// Session-success-rate denominator. Emit immediately after the analytics
// sink is attached — before any parsing, fetching, or I/O that could throw.
// inc-3694 (P0 CHANGELOG crash) threw at checkForReleaseNotes below; every
// event after this point was dead. This beacon is the earliest reliable
// "process started" signal for release health monitoring.
logEvent('tengu_started', {})
```

The comment references a real P0 incident (inc-3694): a CHANGELOG parsing crash caused all events after `tengu_started` to be lost. The fix was to move `tengu_started` to the earliest possible position — sent immediately after the analytics sink is attached, before any I/O that could fail.

**setImmediate Deferral for Attribution Hooks** (Lines 350-361):

```typescript
if (feature('COMMIT_ATTRIBUTION')) {
  // Defer to next tick so the git subprocess spawn runs after first render
  // rather than during the setup() microtask window.
  setImmediate(() => {
    void import('./utils/attributionHooks.js').then(
      ({ registerAttributionHooks }) => registerAttributionHooks()
    );
  });
}
```

`setImmediate` defers the git subprocess spawn to the next event loop iteration. This prevents the spawn from competing with first render for CPU time. If spawned during setup()'s microtask window, the git subprocess would consume CPU during the REPL's first render, reducing first-frame rendering speed.

**Blocking Nature of Release Notes Check** (Lines 386-393):

```typescript
if (!isBareMode()) {
  const { hasReleaseNotes } = await checkForReleaseNotes(
    getGlobalConfig().lastReleaseNotesSeen,
  )
  if (hasReleaseNotes) {
    await getRecentActivity()
  }
}
```

This is one of the few `await` points in setup(). Recent activity data is only loaded when there are new release notes. Bare mode skips it entirely.

#### 1.4.6 Security Verification: Bypass Permissions Check (Lines 396-442)

```typescript
if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
  // Check 1: Prohibit root/sudo (unless in a sandbox)
  if (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)) {
    console.error('--dangerously-skip-permissions cannot be used with root/sudo...');
    process.exit(1);
  }

  // Check 2: Internal builds require sandbox + no network
  if (process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop') {
    const [isDocker, hasInternet] = await Promise.all([
      envDynamic.getIsDocker(),
      env.hasInternetAccess(),
    ]);
    const isBubblewrap = envDynamic.getIsBubblewrapSandbox();
    const isSandbox = process.env.IS_SANDBOX === '1';
    const isSandboxed = isDocker || isBubblewrap || isSandbox;
    if (!isSandboxed || hasInternet) {
      console.error(`--dangerously-skip-permissions can only be used in Docker/sandbox...`);
      process.exit(1);
    }
  }
}
```

**Multi-Layer Security Protection**:

1. **Root check**: Prevents bypassing permissions under root privileges (unless in IS_SANDBOX or Bubblewrap sandbox)
2. **Additional check for internal builds**: Requires both "in a sandbox" and "no network access"
3. **Exception paths**: `local-agent` and `claude-desktop` entry points skip the check — they are trusted Anthropic-hosted launchers, with comments referencing PR #19116 and apps#29127 as precedent

Note the parallel execution of `Promise.all([getIsDocker(), hasInternetAccess()])` — Docker detection and network detection are independent of each other, and running them simultaneously saves time.

---

### 1.5 bootstrap/state.ts — Global State Container

#### 1.5.1 Design Constraints

The file has three prominent comments at the top serving as guards:

```typescript
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
// ... State type definition ...
// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State { ... }
// AND ESPECIALLY HERE
const STATE: State = getInitialState()
```

This "triple warning" pattern is extremely rare in the codebase, reflecting a high degree of vigilance against global state growth.

#### 1.5.2 Initialization Strategy

```typescript
function getInitialState(): State {
  let resolvedCwd = ''
  if (typeof process !== 'undefined' && typeof process.cwd === 'function'
      && typeof realpathSync === 'function') {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // File Provider EPERM on CloudStorage mounts (lstat per path component).
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  // ...
}
```

**Three Defensive Designs**:
1. `typeof process !== 'undefined'`: Compatibility with browser SDK builds (`package.json`'s `browser` field replaces modules)
2. `realpathSync` + NFC normalize: Resolves symlinks and unifies Unicode encoding form, ensuring consistency in path comparisons
3. try-catch for EPERM: macOS CloudStorage mount points may fail `lstat` due to File Provider permissions

#### 1.5.3 Prompt Cache Friendly "Sticky Latches"

state.ts contains multiple `*Latched` fields:

```typescript
afkModeHeaderLatched: boolean | null      // AFK mode beta header
fastModeHeaderLatched: boolean | null     // Fast mode beta header
cacheEditingHeaderLatched: boolean | null  // Cache editing beta header
thinkingClearLatched: boolean | null      // Thinking clear latch
```

These "sticky-on latches" all share the same design purpose — once a beta header is first activated, even if the feature is subsequently disabled, the header continues to be sent. The reason is that prompt cache is based on prefix matching, and frequently toggling headers causes cache invalidation. The comment provides an example: `Once fast mode is first enabled, keep sending the header so cooldown enter/exit doesn't double-bust the prompt cache`.

This is an extremely fine-grained optimization — introducing a state latch mechanism on the client side to avoid Anthropic API prompt cache misses.

#### 1.5.4 Atomicity of switchSession() (Lines 468-479)

```typescript
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}
```

The comment references `CC-34` to explain why `sessionId` and `sessionProjectDir` must be modified together in the same function: if they had independent setters, the time window between two calls could lead to an inconsistent state.

---

### 1.6 utils/startupProfiler.ts — Startup Performance Profiler

#### 1.6.1 Sampling Strategy

```typescript
const STATSIG_SAMPLE_RATE = 0.005  // 0.5%
const STATSIG_LOGGING_SAMPLED =
  process.env.USER_TYPE === 'ant' || Math.random() < STATSIG_SAMPLE_RATE
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED
```

**Dual-Layer Sampling**:
- Internal users (ant): 100% sampling
- External users: 0.5% sampling
- The sampling decision is made once at module load time; `Math.random()` is called only once

**Performance Impact**: For the 99.5% of external users not sampled, `profileCheckpoint()` is a no-op function:

```typescript
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return  // When not sampled, cost is only a single conditional check
  // ...
}
```

#### 1.6.2 Phase Definitions

```typescript
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time:   ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time:  ['cli_entry', 'main_after_run'],
} as const
```

These four phases cover the critical segments of the startup path. `import_time` measures module evaluation duration and is the segment most prone to bloat — every new import added increases this value.

---

## II. Startup Timing Diagram (Blocking/Non-Blocking Annotated Version)

```
Timeline (approximate values):

0ms     cli.tsx loads
        |-- [SYNC] Environment variable preset (COREPACK, NODE_OPTIONS, ablation baseline)    ~0ms
        |-- [SYNC] --version fast path check                              ~0ms
        +-- [SYNC] Other fast path checks (daemon, bridge, bg...)            ~1ms

~2ms    [ASYNC] await import('earlyInput.js')
        +-- startCapturingEarlyInput() — begin buffering user keystrokes

~3ms    [ASYNC] await import('../main.js') <- triggers the following chain
        |
        |-- main.tsx module evaluation begins
        |   |-- [SYNC->ASYNC] profileCheckpoint('main_tsx_entry')        ~0ms
        |   |-- [SYNC->ASYNC] startMdmRawRead() -> spawn plutil subprocess   ~0ms (spawn is non-blocking)
        |   |-- [SYNC->ASYNC] startKeychainPrefetch() -> spawn security   ~0ms (spawn is non-blocking)
        |   |       |-- [PARALLEL BG] OAuth keychain read               ~32ms
        |   |       +-- [PARALLEL BG] Legacy API key keychain read      ~33ms
        |   |
        |   +-- ~180 lines of static import evaluation                              ~132ms
        |       |-- During: MDM subprocess completes                                (~20ms)
        |       +-- During: Keychain subprocess completes                           (~33ms)

~135ms  profileCheckpoint('main_tsx_imports_loaded')
        +-- [SYNC] isBeingDebugged() check + process.exit(1)           ~0ms

~137ms  main() function begins
        |-- [SYNC] NoDefaultCurrentDirectoryInExePath setup              ~0ms
        |-- [SYNC] initializeWarningHandler()                           ~0ms
        |-- [SYNC] Register SIGINT/exit handlers                             ~0ms
        |-- [SYNC->ASYNC] cc:// URL parsing and argv rewriting                    ~0-5ms
        |-- [SYNC->ASYNC] deep link URI handling                            ~0-5ms
        |-- [SYNC->ASYNC] assistant/ssh subcommand parsing                      ~0-2ms
        |-- [SYNC] Interactivity detection + client type determination                          ~0ms
        +-- [SYNC] eagerLoadSettings()                                  ~1-5ms
            |-- eagerParseCliFlag('--settings')
            +-- eagerParseCliFlag('--setting-sources')

~145ms  run() function -> Commander initialization
        +-- new CommanderCommand().configureHelp()                      ~1ms

~146ms  preAction hook fires
        |-- [AWAIT, ~0ms] ensureMdmSettingsLoaded()          <- subprocess already complete
        |-- [AWAIT, ~0ms] ensureKeychainPrefetchCompleted()  <- subprocess already complete
        |-- [AWAIT, ~80ms] init()
        |   |-- [SYNC] enableConfigs()                                  ~5ms
        |   |-- [SYNC] applySafeConfigEnvironmentVariables()            ~3ms
        |   |-- [SYNC] applyExtraCACertsFromConfig()                    ~1ms
        |   |-- [SYNC] setupGracefulShutdown()                          ~1ms
        |   |-- [FIRE-FORGET] initialize1PEventLogging()                (bg)
        |   |-- [FIRE-FORGET] populateOAuthAccountInfoIfNeeded()        (bg)
        |   |-- [FIRE-FORGET] initJetBrainsDetection()                  (bg)
        |   |-- [FIRE-FORGET] detectCurrentRepository()                 (bg)
        |   |-- [SYNC] initializeRemoteManagedSettingsLoadingPromise()  ~0ms
        |   |-- [SYNC] initializePolicyLimitsLoadingPromise()           ~0ms
        |   |-- [SYNC] recordFirstStartTime()                           ~0ms
        |   |-- [SYNC] configureGlobalMTLS()                            ~5ms
        |   |-- [SYNC] configureGlobalAgents()                          ~5ms
        |   |-- [FIRE-FORGET] preconnectAnthropicApi()     <- TCP+TLS handshake begins (bg)
        |   |-- [AWAIT, CCR-only] initUpstreamProxy()                   ~10ms
        |   |-- [SYNC] setShellIfWindows()                              ~0ms
        |   |-- [SYNC] registerCleanup(shutdownLspServerManager)        ~0ms
        |   +-- [AWAIT, if scratchpad] ensureScratchpadDir()            ~5ms
        |
        |-- [AWAIT, ~2ms] import('sinks.js') + initSinks()
        |-- [SYNC] handlePluginDir()                                    ~1ms
        |-- [SYNC] runMigrations()                                      ~3ms
        |-- [FIRE-FORGET] loadRemoteManagedSettings()                   (bg)
        |-- [FIRE-FORGET] loadPolicyLimits()                            (bg)
        +-- [FIRE-FORGET] uploadUserSettingsInBackground()              (bg)

~230ms  action handler begins
        |-- [SYNC] --bare environment variable setup                                  ~0ms
        |-- [SYNC] Kairos/Assistant mode determination and initialization                     ~0-10ms
        |-- [SYNC] Permission mode parsing                                         ~2ms
        |-- [SYNC] MCP configuration parsing (JSON/file)                             ~5ms
        |-- [SYNC] Tool permission context initialization                                  ~3ms
        |
        |-- [SYNC, <1ms] initBuiltinPlugins() + initBundledSkills()
        |
        |-- +--- [PARALLEL] ------------------------------------+
        |   | setup()              ~28ms                        |
        |   |  |-- [AWAIT] startUdsMessaging()  ~20ms           |
        |   |  |-- [AWAIT] teammateModeSnapshot ~1ms            |
        |   |  |-- [AWAIT] terminalBackupRestore ~2ms           |
        |   |  |-- [SYNC] setCwd() + captureHooks ~2ms          |
        |   |  |-- [SYNC] initFileChangedWatcher ~1ms           |
        |   |  |-- [SYNC] initSessionMemory() ~0ms              |
        |   |  |-- [SYNC] initContextCollapse() ~0ms            |
        |   |  |-- [FIRE-FORGET] lockCurrentVersion()           |
        |   |  |-- [FIRE-FORGET] getCommands(prefetch)          |
        |   |  |-- [FIRE-FORGET] loadPluginHooks()              |
        |   |  |-- [setImmediate] attribution hooks             |
        |   |  |-- [SYNC] initSinks() + tengu_started           |
        |   |  |-- [FIRE-FORGET] prefetchApiKey()               |
        |   |  +-- [AWAIT] checkForReleaseNotes()               |
        |   |                                                   |
        |   | getCommands(cwd)     ~10ms                        |
        |   | getAgentDefs(cwd)    ~10ms                        |
        |   +--- [PARALLEL] ------------------------------------+
        |
        |-- [AWAIT] setupPromise completes                                   +28ms
        |   |-- [Non-interactive] applyConfigEnvironmentVariables()
        |   |-- [Non-interactive] void getSystemContext()
        |   +-- [Non-interactive] void getUserContext()
        |
        +-- [AWAIT] Promise.all([commands, agents])                     +0-5ms

~265ms  Interactive mode branch
        |-- [AWAIT] createRoot() (Ink rendering engine initialization)                    ~5ms
        |-- [SYNC] logEvent('tengu_timer', startup)
        |-- [AWAIT] showSetupScreens()
        |   |-- Trust dialog                                              (user interaction, 0-infinity ms)
        |   |-- OAuth login                                              (user interaction)
        |   +-- Onboarding guide                                                (user interaction)
        |
        |-- [PARALLEL, bg] mcpConfigPromise (config I/O completes during this period)
        |-- [PARALLEL, bg] claudeaiConfigPromise (-p mode only)
        |
        |-- [AWAIT] mcpConfigPromise resolves
        |-- [FIRE-FORGET] prefetchAllMcpResources()
        |-- [FIRE-FORGET] processSessionStartHooks('startup')
        |
        +-- Various validations (org, settings, quota...)

~350ms+ launchRepl() or runHeadless()
        +-- [FIRE-FORGET] startDeferredPrefetches()
            |-- initUser()
            |-- getUserContext()
            |-- prefetchSystemContextIfSafe()
            |-- getRelevantTips()
            |-- countFilesRoundedRg(3s timeout)
            |-- initializeAnalyticsGates()
            |-- prefetchOfficialMcpUrls()
            |-- refreshModelCapabilities()
            |-- settingsChangeDetector.initialize()
            |-- skillChangeDetector.initialize()
            +-- [ant-only] eventLoopStallDetector
```

---

## III. Design Trade-off Analysis

### 3.1 Module Top-Level Side Effects vs. Pure Modules

**Choice**: Use top-level side effects to start subprocesses at main.tsx lines 12-20.

**Trade-offs**:
- **Benefit**: Hides 65ms of keychain reads and MDM subprocess startup at nearly zero incremental cost
- **Cost**: Violates the "pure module" principle (imports should have no side effects), increases implicit coupling in the module dependency graph
- **Mitigation**: Explicitly marked with `eslint-disable` comments, with detailed explanations of timing requirements
- **Industry Comparison**: This technique is very rare in CLI tools. Most CLI frameworks (like oclif, yargs) rely on lazy-loading rather than top-level side effects. Chrome DevTools' startup optimization has a similar "import-time side-effect" pattern

### 3.2 Commander preAction Hook vs. Direct Initialization

**Choice**: Place init() in Commander's preAction hook rather than calling it at the top level.

**Trade-offs**:
- **Benefit**: `claude --help` doesn't trigger initialization, saving ~100ms
- **Cost**: Initialization logic is coupled with command execution, increasing comprehension difficulty
- **Industry Comparison**: The oclif framework uses a similar `init()` hook pattern. Commander's preAction is a more lightweight approach

### 3.3 Parallel setup() vs. Serial Execution

**Choice**: Execute setup() in parallel with getCommands()/getAgentDefs().

**Trade-offs**:
- **Benefit**: Hides setup()'s ~28ms (UDS socket binding)
- **Cost**: Introduces race condition possibilities (already fixed by moving initBundledSkills out)
- **Cost**: Worktree mode must forgo parallelism (setup may chdir)
- **Code Complexity**: Requires `.catch(() => {})` to suppress transient unhandledRejection

### 3.4 --bare Mode System-Wide Permeation vs. Independent Path

**Choice**: Use `isBareMode()` checks at multiple locations to skip non-core work, rather than creating an independent bare startup path.

**Trade-offs**:
- **Benefit**: Avoids code duplication; bare mode naturally benefits from all core path improvements
- **Cost**: `isBareMode()` checks are scattered throughout the code, increasing mental maintenance overhead
- **Performance Data**: Comments in setup.ts annotate specific savings, such as "attribution hook stat check (measured) — 49ms"

### 3.5 Content-Hash Temporary Files vs. Random UUID

**Choice**: Use content-hash paths for --settings JSON instead of random UUIDs.

**Trade-offs**:
- **Benefit**: Avoids prompt cache invalidation (12x input token cost difference)
- **Cost**: Processes with the same content share a temporary file — theoretically there could be concurrent write issues (in practice the file content is identical, so it's harmless)
- **Originality**: This is a very rare optimization. Reverse-mapping API prompt cache behavior to local file path generation strategy demonstrates deep end-to-end understanding of the entire system's performance

### 3.6 Sticky Latches vs. Dynamic Headers

**Choice**: Use a "once activated, never deactivated" latch strategy for beta headers.

**Trade-offs**:
- **Benefit**: Avoids prompt cache misses (~50-70K tokens of cache value)
- **Cost**: Feature state changes are not fully reflected in API requests (header says "enabled" but the feature may actually be disabled)
- **Safety**: Headers only affect billing/routing, not feature behavior (features are controlled through parameters like `body.speed`)

---

## IV. Patterns Worth Learning

### 4.1 Import-time Parallel Prefetch

Leverages the deterministic timing of ES module evaluation to execute subprocesses in parallel during import chain evaluation. This demonstrates deep understanding of the JavaScript execution model:

```
import A -> A's top-level code executes (synchronous)
import B -> B's top-level code executes (synchronous)
... 135ms of synchronous module evaluation ...
```

Within these 135ms, subprocesses spawned by `startMdmRawRead()` and `startKeychainPrefetch()` run in parallel at the OS level. Node.js/Bun's event loop doesn't poll until module evaluation completes, but subprocesses are independent processes not constrained by the event loop.

### 4.2 Memoize + Fire-and-Forget + Await-Later Pattern

Multiple functions use the same three-phase pattern:
1. **Fire**: Start the async operation at the earliest reasonable point in the timeline (`void getSystemContext()`)
2. **Forget**: Don't wait for the result, continue executing subsequent synchronous work
3. **Await Later**: Await when the result is actually needed (due to memoize, returns the same Promise)

This pattern recurs in `getCommands()`, `getSystemContext()`, `getUserContext()`, and other functions.

### 4.3 Combined Feature Gate + DCE (Dead Code Elimination)

```typescript
const module = feature('FLAG') ? require('./module.js') : null;
```

`feature()` is evaluated at build time, and `require` only exists in the bundle when the condition is true. This is more thorough than runtime conditional imports — the module itself disappears from the bundle. Every module eliminated by DCE directly reduces bundle size and first-import evaluation time.

### 4.4 "Bug Archaeology" in Comments

Comments in the code don't just explain current logic — they also record the history of problems. For example:

- `inc-3694 (P0 CHANGELOG crash)` — a real incident number
- `gh-33508` — a GitHub issue number
- `CC-34` — an internal bug number
- `Previously ran inside setup() after ~20ms of await points` — the state before the fix

This kind of "archaeological commenting" is crucial for subsequent maintainers to understand why the code is written the way it is. It answers the question "Why not do it the simpler way?" — because the simpler way was already tried and failed.

### 4.5 Multi-Layer Security Boundaries

The system strictly distinguishes between "pre-trust" and "post-trust" operations:

| Operation Type | Trust Requirement | Code Location |
|---------------|------------------|---------------|
| applySafeConfigEnvironmentVariables() | None (safe subset) | init.ts:74 |
| applyConfigEnvironmentVariables() | Requires trust | main.tsx:1965 (non-interactive) / after trust dialog (interactive) |
| MCP config reading | None (pure file I/O) | main.tsx:1800-1814 |
| MCP resource prefetch | Requires trust (involves code execution) | main.tsx:2404+ |
| prefetchSystemContextIfSafe() | Checks trust status | main.tsx:360-380 |
| LSP manager initialization | Requires trust | main.tsx:2321 |
| git command execution | Requires trust (git hooks can execute arbitrary code) | Multiple locations |

This layered trust model ensures that even when running in a malicious repository, no dangerous operations are executed without user confirmation.

---

## V. Code Quality Assessment

### 5.1 Elegant Aspects

1. **Exceptionally high comment quality**: Nearly every non-obvious decision has detailed comments, including performance data (ms values, percentages), bug references, and timing dependency explanations
2. **Performance awareness throughout**: From import-level subprocess parallelism to API prompt cache friendly temporary file naming, this reflects end-to-end optimization thinking across the entire request chain
3. **Clear security boundaries**: Pre-trust/post-trust operation distinctions are strict, with comments explaining every security decision
4. **Consistent error handling**: Fire-and-forget uses `void` + `.catch()`, intentional ignoring uses try-catch + comments

### 5.2 Technical Debt

1. **main.tsx is too large**: A single file of 4683 lines carries too many responsibilities. The action handler alone is ~2800 lines and should be split into independent modules
2. **9-parameter setup() function**: The parameter list is too long, suggesting responsibilities may be overly concentrated. A configuration object pattern could be considered
3. **Scattered `"external" === 'ant'` checks**: Build-time string replacement is effective but lacks type safety. Misspelling as `"external" == 'ant'` would produce no compilation error
4. **TODO traces**: The `TODO: Consolidate other prefetches into a single bootstrap request` at `main.tsx:2355` indicates the current multi-request prefetch pattern still needs optimization
5. **Excessive `process.exit()` usage**: There are numerous direct `process.exit(1)` calls in setup.ts and main.tsx. While this is common practice in CLI tools, it hinders testing and graceful cleanup

### 5.3 Industry Comparison

| Optimization Technique | Claude Code | Other CLI Tools |
|----------------------|-------------|-----------------|
| Import-time subprocess prefetch | Yes (MDM + Keychain) | Extremely rare |
| Fast path short-circuiting | Yes (10+ fast paths) | Common (e.g., git, docker) |
| preAction hook deferred initialization | Yes | oclif has similar design |
| API prompt cache friendly paths | Yes (content-hash) | No known precedent |
| Sticky beta header latching | Yes | No known precedent |
| Build-time feature flags + DCE | Yes | Rust CLIs have similar cargo features |
| Telemetry sampling decision | One-time at module load | Common |
| Dual-layer trust model | Yes (safe vs full env vars) | Rare (usually all-or-nothing) |

Claude Code's investment in startup optimization far exceeds most CLI tools. This reflects the uniqueness of its use case — as an interactive AI programming assistant that requires frequent restarts and is sensitive to first-response latency, every millisecond of startup optimization is perceptible to users. Optimizations like prompt cache and beta header latching address challenges unique to LLM APIs, with no corresponding needs in traditional CLI tools.
