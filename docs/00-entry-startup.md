# 00 - 入口与启动优化（深度分析版）

## 概述

Claude Code 的启动系统采用了精心设计的多层入口架构，从用户输入 `claude` 命令到进入主交互循环，经历了 cli.tsx -> main.tsx -> init.ts -> setup.ts 四个主要阶段。整个启动路径的核心设计哲学是：**尽可能延迟加载，尽可能并行执行，尽可能减少阻塞**。

系统通过多种优化手段将启动时间压缩到极致：模块顶层的副作用式预取（MDM 配置、Keychain 读取）、Commander preAction hook 延迟初始化、setup() 与命令加载的并行执行、以及渲染后的延迟预取（startDeferredPrefetches）。`--bare` 模式作为极简启动路径，跳过几乎所有非核心的预热和后台任务。

bootstrap/state.ts 作为全局状态容器，在模块加载时就完成初始化，是整个系统中最先就绪的模块之一，为后续所有子系统提供基础状态支撑。

---

## 一、逐文件逐函数深度分析

### 1.1 entrypoints/cli.tsx — 启动分发器

**文件角色**：程序真正的入口点。核心策略是"快速路径优先"——对特殊命令尽早拦截处理，避免加载完整的 main.tsx 模块树。

#### 1.1.1 顶层副作用区（第 1-26 行）

```typescript
// cli.tsx:5 — 修复 corepack 自动固定 Bug
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// cli.tsx:9-13 — CCR（Claude Code Remote）环境设置堆大小
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}

// cli.tsx:21-26 — 消融基线实验
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', ...]) {
    process.env[k] ??= '1';
  }
}
```

**逐行分析**：

- **COREPACK_ENABLE_AUTO_PIN**（第 5 行）：这是一个 Bug 修复。Corepack 会自动修改用户的 `package.json` 添加 yarnpkg，对于一个 CLI 工具来说这是不可接受的副作用。注释明确标注了这是 "Bugfix"。
- **NODE_OPTIONS 堆大小**（第 9-13 行）：CCR 容器分配 16GB 内存，但 Node.js 默认堆上限远低于此。设置 8192MB 确保子进程不会因内存不足而崩溃。注意它**追加**而非覆盖现有 NODE_OPTIONS，尊重用户的自定义配置。
- **消融基线实验**（第 21-26 行）：这是 Anthropic 内部用于衡量各个功能对整体表现影响的 A/B 测试机制。`feature('ABLATION_BASELINE')` 在构建时求值，外部版本中整个 if 块被 DCE 消除。使用 `??=` 而非 `=` 确保实验只设置默认值，不覆盖手动配置。

**设计权衡**：顶层副作用违反了通常的"纯模块"原则，但对于需要在任何 import 之前设置的环境变量，这是唯一正确的位置。代码通过 `eslint-disable` 注释明确标注了对这一规则的有意违反。

#### 1.1.2 main() 快速路径分发（第 33-298 行）

`main()` 函数是一个精心设计的命令分发器。它检查 `process.argv`，按优先级匹配以下快速路径：

| 优先级 | 命令/参数 | 处理方式 | 模块加载量 | 延迟 |
|--------|-----------|----------|-----------|------|
| 1 | `--version` / `-v` / `-V` | 直接输出 MACRO.VERSION | 零 import | <1ms |
| 2 | `--dump-system-prompt` | enableConfigs + getSystemPrompt | 最小化 | ~20ms |
| 3 | `--claude-in-chrome-mcp` | 启动 Chrome MCP 服务器 | 专用模块 | 视情况 |
| 4 | `--chrome-native-host` | 启动 Chrome Native Host | 专用模块 | 视情况 |
| 5 | `--computer-use-mcp` | 启动 Computer Use MCP | 专用模块（CHICAGO_MCP 门控）| 视情况 |
| 6 | `--daemon-worker` | 守护进程 worker | 极简（无 enableConfigs） | <5ms |
| 7 | `remote-control`/`rc`/... | Bridge 远程控制 | Bridge 模块 | ~50ms |
| 8 | `daemon` | 守护进程主入口 | 守护进程模块 | ~30ms |
| 9 | `ps`/`logs`/`attach`/`kill`/`--bg` | 后台会话管理 | bg.js | ~30ms |
| 10 | `new`/`list`/`reply` | 模板任务 | templateJobs | ~30ms |
| 11 | `--worktree --tmux` | Tmux worktree 快速路径 | worktree 模块 | ~10ms |

**关键设计细节**：

```typescript
// cli.tsx:37-42 — --version 的零依赖快速路径
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
  console.log(`${MACRO.VERSION} (Claude Code)`);
  return;  // 无任何 import，最快返回
}
```

`MACRO.VERSION` 是构建时内联的常量，因此 `--version` 路径的执行不需要任何 `import()`，这是所有路径中最快的。`args.length === 1` 的检查确保 `claude --version --debug` 不会误入此路径。

```typescript
// cli.tsx:96-106 — daemon-worker 的极简路径
// 注释明确说明：No enableConfigs(), no analytics sinks at this layer —
// workers are lean. If a worker kind needs configs/auth, it calls them inside its run() fn.
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
  await runDaemonWorker(args[1]);
  return;
}
```

`--daemon-worker` 路径是对"延迟到需要时"原则的极致体现——即使是 `enableConfigs()` 这样基础的初始化都被推到了 worker 内部按需调用。

#### 1.1.3 进入完整启动路径（第 287-298 行）

```typescript
// cli.tsx:288-298 — 加载完整 CLI
const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
startCapturingEarlyInput();  // 在 main.tsx 模块评估期间捕获用户键入
profileCheckpoint('cli_before_main_import');
const { main: cliMain } = await import('../main.js');  // 触发 ~135ms 的模块评估
profileCheckpoint('cli_after_main_import');
await cliMain();
```

**`startCapturingEarlyInput()` 的时序意义**：这个调用在 `import('../main.js')` 之前执行。`main.js` 的 import 触发约 135ms 的模块评估链（200+ 行静态 import），在此期间用户可能已经开始打字。`earlyInput` 模块在这段时间内缓冲键入事件，确保用户的输入不会丢失。这是一个对用户体验的细致考量。

**`--bare` 在 cli.tsx 中的设置**（第 282-285 行）：

```typescript
if (args.includes('--bare')) {
  process.env.CLAUDE_CODE_SIMPLE = '1';
}
```

注意 `--bare` 的环境变量在 cli.tsx 层就设置了，早于 main.tsx 的加载。这确保 `isBareMode()` 在模块顶层求值时就能返回正确值，使得 `startKeychainPrefetch()` 等副作用在 bare 模式下被跳过。

---

### 1.2 main.tsx — 核心启动引擎（4683 行）

这是整个系统最大、最复杂的文件。它同时扮演了**模块依赖图根节点**、**Commander CLI 定义**、**初始化流程编排器**三个角色。

#### 1.2.1 顶层预取三连发（第 1-20 行）

```typescript
// main.tsx:1-8 — 注释说明顺序要求
// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query)
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API key)

import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');                    // [1] 标记入口时间

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();                                      // [2] 启动 MDM 子进程

import { ensureKeychainPrefetchCompleted, startKeychainPrefetch }
  from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();                                // [3] 启动 Keychain 预读
```

**函数级分析**：

**`startMdmRawRead()`**（rawRead.ts:120-123）：
- **输入**：无参数
- **输出**：设置模块级变量 `rawReadPromise`
- **副作用**：在 macOS 上启动 `plutil` 子进程读取 MDM plist 配置；在 Windows 上启动 `reg query` 读取注册表
- **幂等性**：内部守卫 `if (rawReadPromise) return`，保证只执行一次
- **阻塞性**：**非阻塞**。`execFile()` 是异步的，立即返回。子进程在后台运行
- **性能细节**：rawRead.ts:64-69 中有一个重要的快速路径——对每个 plist 路径先用 **同步** `existsSync()` 检查文件是否存在。注释解释了为什么用同步调用：`Uses synchronous existsSync to preserve the spawn-during-imports invariant: execFilePromise must be the first await so plutil spawns before the event loop polls`。在非 MDM 机器上，plist 文件不存在，`existsSync` 跳过 plutil 子进程启动（约 5ms/次），直接返回空结果

**`startKeychainPrefetch()`**（keychainPrefetch.ts:69-89）：
- **输入**：无参数
- **输出**：设置模块级变量 `prefetchPromise`
- **副作用**：在 macOS 上启动两个并行的 `security find-generic-password` 子进程：(a) OAuth 凭据 ~32ms；(b) 遗留 API Key ~33ms。非 darwin 平台为 no-op
- **关键细节**：超时处理。keychainPrefetch.ts:54-59 中，如果子进程超时（`err.killed`），**不会**将结果写入缓存——让后续同步路径重试。这防止了一种微妙的 bug：keychain 可能有 key，但子进程超时导致 `null` 被缓存，后续 `getApiKeyFromConfigOrMacOSKeychain()` 读到缓存认为没有 key
- **`isBareMode()` 守卫**（第 70 行）：bare 模式跳过 keychain 读取。注释说明了原因：`--bare` 模式下认证严格限制为 ANTHROPIC_API_KEY 或 apiKeyHelper，OAuth 和 keychain 从不被读取

**为什么注释中说"~65ms on every macOS startup"？** keychainPrefetch.ts:8-9 解释：`isRemoteManagedSettingsEligible() reads two separate keychain entries SEQUENTIALLY via sync execSync`。如果没有预取，两个 keychain 读取会在 `applySafeConfigEnvironmentVariables()` 中被串行执行。通过并行预取，这 65ms 被隐藏在 import 评估时间内。

#### 1.2.2 静态 import 区（第 21-200 行）

约 180 行静态 import 语句，评估约 135ms。这些 import 有以下几个关键特征：

**惰性 require 打破循环依赖**（第 68-73 行）：

```typescript
// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () =>
  require('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () =>
  require('./utils/swarm/backends/teammateModeSnapshot.js');
```

**分析**：这三个惰性 require 都与 Agent Swarm（团队协作）相关。循环依赖链是 `teammate.ts -> AppState.tsx -> ... -> main.tsx`。使用惰性 require 而非顶层 import 意味着：
1. 模块只在首次调用时才被求值
2. 此时循环依赖链中的其他模块已经完成初始化
3. 函数返回的类型通过 `as typeof import(...)` 保持类型安全

**条件 require 与 DCE（Dead Code Elimination）**（第 74-81 行）：

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

**设计权衡**：`feature()` 来自 `bun:bundle`，在构建时求值为 `true` 或 `false`。当 feature flag 为 `false` 时，三元表达式的 `require` 分支被视为死代码，Bun 的 bundler 将其从最终产物中完全消除。这比运行时条件 import 更彻底——不仅不加载模块，连模块文件本身都不会存在于 bundle 中。

**`autoModeStateModule`**（第 171 行）：同一模式，但位于 import 区末尾：

```typescript
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? require('./utils/permissions/autoModeState.js') : null;
```

这个模块只在 TRANSCRIPT_CLASSIFIER feature 开启时存在，用于 auto mode 的分类器状态管理。

**import 结束标记**（第 209 行）：

```typescript
profileCheckpoint('main_tsx_imports_loaded');
```

这个 checkpoint 精确标记了所有静态 import 评估完成的时间点。结合 `main_tsx_entry`，可以计算出准确的 import 评估耗时（即 `import_time` 阶段）。

#### 1.2.3 防调试保护（第 231-271 行）

```typescript
function isBeingDebugged() {
  const isBun = isRunningWithBun();
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // Bun 有一个 bug：单文件可执行中 process.argv 的参数会泄漏到 process.execArgv
      // 因此只检查 --inspect 系列，跳过 legacy --debug
      return /--inspect(-brk)?/.test(arg);
    } else {
      // Node.js 检查 --inspect 和 legacy --debug 两类标志
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

// 外部版本禁止调试
if ("external" !== 'ant' && isBeingDebugged()) {
  process.exit(1);  // 静默退出，无错误信息
}
```

**三层检测**：
1. **execArgv 参数检测**：区分 Bun 和 Node.js 的 inspect 标志格式
2. **NODE_OPTIONS 环境变量检测**：捕获通过环境变量注入的调试标志
3. **inspector 模块运行时检测**：检查 inspector URL 是否已激活（覆盖通过代码开启调试的情况）

**设计权衡**：`"external" !== 'ant'` 是构建时替换的字符串。内部版本中 `"external"` 被替换为 `'ant'`，条件永远为 `false`，整个检测被跳过。外部版本中保持为 `"external"`，条件为 `true`，调试被禁止。这是一种逆向工程防护措施——静默退出（不输出任何信息）增加了逆向难度。

**Bun 兼容性注释**：代码中记录了 Bun 的一个已知 Bug（类似 oven-sh/bun#11673）——单文件可执行中应用参数泄漏到 `process.execArgv`。这导致如果检查 legacy `--debug` 标志会误判。解决方案是 Bun 路径只检查 `--inspect` 系列。

#### 1.2.4 辅助函数区（第 211-584 行）

**`logManagedSettings()`**（第 216-229 行）：
- 将企业管理设置的 key 列表上报到 Statsig 分析
- 用 try-catch 包裹，静默忽略错误——"this is just for analytics"
- 在 init() 完成后调用，确保设置系统已加载

**`logSessionTelemetry()`**（第 279-290 行）：
- 上报 skills 和 plugins 的遥测数据
- 同时从交互式路径和非交互式(-p)路径调用
- 内部注释解释了为何需要两个调用点：`both go through main.tsx but branch before the interactive startup path`

**`runMigrations()`**（第 326-352 行）：

```typescript
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    // ... 共 11 个同步迁移
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION
      ? prev : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION });
  }
  // 异步迁移 — fire and forget
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}
```

**设计细节**：
- 版本号机制避免重复运行迁移
- `saveGlobalConfig` 使用 CAS（Compare-And-Swap）模式：只在版本不匹配时写入
- 异步迁移 `migrateChangelogFromConfig()` 独立于版本检查，失败时静默重试
- 注释 `@[MODEL LAUNCH]` 提示开发者在发布新模型时考虑字符串迁移需求

**`prefetchSystemContextIfSafe()`**（第 360-380 行）：

```typescript
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();
  if (isNonInteractiveSession) {
    void getSystemContext();  // -p 模式隐含信任
    return;
  }
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    void getSystemContext();  // 已建立信任
  }
  // 否则不预取——等待信任建立
}
```

**安全边界分析**：这个函数体现了系统的信任模型。`getSystemContext()` 内部执行 `git status`、`git log` 等命令，而 git 可以通过 `core.fsmonitor`、`diff.external` 等配置执行任意代码。因此：
- **非交互模式**（-p）：隐含信任，直接预取。帮助文档明确说明了这一前提
- **交互模式**：必须检查信任对话框是否已被接受
- **首次运行**：不预取，等待用户在信任对话框中确认

**`startDeferredPrefetches()`**（第 388-431 行）：

```typescript
export function startDeferredPrefetches(): void {
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) || isBareMode()) {
    return;
  }

  void initUser();                          // 用户信息
  void getUserContext();                    // CLAUDE.md 等上下文
  prefetchSystemContextIfSafe();            // git status/log
  void getRelevantTips();                   // 提示信息

  // 云提供商凭据预取（条件性）
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }

  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);  // 文件计数
  void initializeAnalyticsGates();          // 分析门控
  void prefetchOfficialMcpUrls();           // 官方 MCP URL
  void refreshModelCapabilities();          // 模型能力

  void settingsChangeDetector.initialize(); // 设置变更检测
  void skillChangeDetector.initialize();    // 技能变更检测

  // 仅内部版本：事件循环阻塞检测器
  if ("external" === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}
```

**性能哲学分析**：

这个函数的注释极其精确地描述了它的设计意图：

1. `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` 守卫：用于性能基准测试。在测试启动性能时，这些预取会产生 CPU 和事件循环竞争，影响测量准确性
2. `--bare` 守卫：`These are cache-warms for the REPL's first-turn responsiveness... Scripted -p calls don't have a "user is typing" window to hide this work in`
3. `AbortSignal.timeout(3000)` 用于文件计数：3 秒后强制中止，防止大仓库的文件计数阻塞过久
4. 事件循环阻塞检测器只在内部版本运行，阈值 >500ms

**`loadSettingsFromFlag()`**（第 432-483 行）— Prompt Cache 友好设计：

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

**这是一个精妙的性能优化**。问题链：
1. `--settings` 传入的临时文件路径会出现在 Bash 工具的沙箱描述中
2. 沙箱描述是工具定义的一部分，发送到 API
3. API 的 prompt cache 基于前缀匹配
4. 随机 UUID 路径 → 每次 `query()` 调用路径不同 → 工具定义不同 → prompt cache 失效
5. Cache 失效意味着 12 倍 input token 成本

解决方案是使用内容哈希替代随机 UUID，相同的设置内容生成相同的路径，跨进程边界保持一致。

#### 1.2.5 main() 函数（第 585-856 行）

**函数签名**：`export async function main()`
- **输入**：无（从 `process.argv` 读取）
- **输出**：无（设置全局状态，最终调用 `run()`）
- **副作用**：
  1. 设置 `NoDefaultCurrentDirectoryInExePath`（Windows 安全防护）
  2. 注册 SIGINT 和 exit 处理器
  3. 解析和改写 `process.argv`（cc://、assistant、ssh 子命令）
  4. 确定交互性和客户端类型
  5. 提前加载 settings

**Windows PATH 劫持防护**（第 590-591 行）：

```typescript
process.env.NoDefaultCurrentDirectoryInExePath = '1';
```

这行代码的注释引用了 Microsoft 文档。在 Windows 上，`SearchPathW` 默认会搜索当前目录，攻击者可以在当前目录放置同名恶意可执行文件。设置这个环境变量禁用此行为。

**SIGINT 处理器的微妙设计**（第 598-606 行）：

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

print 模式有自己的 SIGINT 处理器（中止 API 请求并优雅退出），这里的处理器必须让步。如果两个处理器都调用 `process.exit()`，会产生竞态。

**cc:// URL 改写**（第 612-642 行）：

这段代码展示了如何在不引入子命令的情况下支持协议 URL。核心策略是**改写 argv**：
- 交互模式：从 argv 中剥离 `cc://` URL，存储到 `_pendingConnect` 对象中，让主命令路径处理
- 非交互模式（-p）：改写为内部 `open` 子命令

这种改写策略的优势是复用了整个交互式 TUI 栈，避免了为 cc:// 创建一条完全独立的代码路径。

**交互性检测**（第 798-808 行）：

```typescript
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
const hasInitOnlyFlag = cliArgs.includes('--init-only');
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
```

四个条件的逻辑 OR：-p 标志、--init-only 标志、SDK URL 模式、非 TTY 输出。注意 `!process.stdout.isTTY` 是最后的兜底——即使没有任何标志，如果 stdout 不是终端（管道/文件重定向），也视为非交互。

#### 1.2.6 run() 与 Commander preAction（第 884-967 行）

**Commander 初始化**（第 884-903 行）：

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

`Object.assign` 的原因在注释中说明：`Commander supports compareOptions at runtime but @commander-js/extra-typings doesn't include it in the type definitions`。这是一个 TypeScript 类型覆盖不足的解决方案。

**preAction Hook — 核心初始化编排器**（第 907-967 行）：

```typescript
program.hook('preAction', async thisCommand => {
  profileCheckpoint('preAction_start');

  // [1] 等待模块顶层预取完成（几乎零成本）
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
  profileCheckpoint('preAction_after_mdm');

  // [2] 核心初始化
  await init();
  profileCheckpoint('preAction_after_init');

  // [3] 设置终端标题
  if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
    process.title = 'claude';
  }

  // [4] 挂载日志 sink
  const { initSinks } = await import('./utils/sinks.js');
  initSinks();

  // [5] 处理 --plugin-dir
  const pluginDir = thisCommand.getOptionValue('pluginDir');
  if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
    setInlinePlugins(pluginDir);
    clearPluginCache('preAction: --plugin-dir inline plugins');
  }

  // [6] 运行数据迁移
  runMigrations();

  // [7] 远程托管设置和策略加载（非阻塞）
  void loadRemoteManagedSettings();
  void loadPolicyLimits();

  // [8] 设置同步上传（非阻塞）
  if (feature('UPLOAD_USER_SETTINGS')) {
    void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
  }
});
```

**为什么使用 preAction hook 而非直接调用？**

注释明确说明：`Use preAction hook to run initialization only when executing a command, not when displaying help`。当用户运行 `claude --help` 时，Commander 直接输出帮助文本而不触发 preAction，避免了不必要的初始化开销（init()、数据迁移等）。这在"显示帮助"这一常见操作上节省了约 100ms。

**步骤 [1] 的时序分析**：

```typescript
// Nearly free — subprocesses complete during the ~135ms of imports above.
// Must resolve before init() which triggers the first settings read
// (applySafeConfigEnvironmentVariables -> getSettingsForSource('policySettings')
// -> isRemoteManagedSettingsEligible -> sync keychain reads otherwise ~65ms).
await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
```

注释中的时序推理值得仔细分析：
1. MDM 和 Keychain 子进程在 main.tsx 第 16 和 20 行启动
2. 后续 ~135ms 的 import 评估提供了充足的并行窗口
3. 此时 await 几乎立即完成（子进程已在 import 期间结束）
4. **关键依赖**：必须在 `init()` 之前完成，因为 `init()` 中的 `applySafeConfigEnvironmentVariables()` 会调用 `isRemoteManagedSettingsEligible()`，后者如果缓存未命中则执行同步 keychain 读取（~65ms）

**步骤 [5] 中 --plugin-dir 的处理历史**：

注释引用了 `gh-33508`，解释了为什么在 preAction 中处理 `--plugin-dir`：
- `--plugin-dir` 是顶层 program option
- 子命令（`plugin list`、`mcp *`）有独立的 action handler，看不到这个选项
- 必须在 preAction 中提前设置，确保 `getInlinePlugins()` 在所有代码路径中都可用

**Print 模式跳过子命令注册优化**（第 3875-3890 行）：

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

这段代码展示了一个基于实测数据的优化：52 个子命令的注册路径耗时约 65ms，其中 25ms 是 settings Zod 解析，40ms 是同步 keychain 子进程。print 模式永远不会调度到这些子命令（Commander 将 prompt 路由到默认 action），因此直接跳过。

#### 1.2.7 Action Handler — 启动主流程（第 1007 行起）

这是 main.tsx 中最长的函数（约 2800 行），处理所有 CLI 选项并准备运行环境。

**setup() 与命令加载的并行执行**（第 1913-1934 行）：

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

// 抑制短暂的 unhandledRejection
commandsPromise?.catch(() => {});
agentDefsPromise?.catch(() => {});
await setupPromise;

const [commands, agentDefinitions] = await Promise.all([
  commandsPromise ?? getCommands(currentCwd),
  agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
]);
```

**竞态条件修复的考古学**：

注释记录了一个真实发生过的竞态条件，值得逐步拆解：

1. **原始代码**：`initBundledSkills()` 在 `setup()` 内部执行
2. **setup() 结构**：开头是 `await startUdsMessaging()` (~20ms socket 绑定)
3. **问题**：setup() 的 await 释放控制权 → `getCommands()` 的微任务先执行 → 调用 `getBundledSkills()` → 返回空数组（因为 `initBundledSkills()` 还没执行）→ 结果被 memoize 缓存 → 后续调用全部返回空列表
4. **修复**：将 `initBuiltinPlugins()` 和 `initBundledSkills()` 移到 `setup()` 调用之前，它们是纯内存操作 (<1ms, zero I/O)，不会阻塞

**`.catch(() => {})` 的含义**：这不是忽略错误，而是防止 Node.js 的 `unhandledRejection` 在 `setupPromise` 的 ~28ms await 期间触发。最终的 `Promise.all` 仍然会观察到这些 rejection。

**worktree 模式的守卫**：`commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)`。当 `--worktree` 开启时，`setup()` 可能执行 `process.chdir()`（setup.ts:271），因此不能用 setup 前的 cwd 预启动命令加载。null 分支在 setup 完成后用正确的 cwd 重新加载。

---

### 1.3 entrypoints/init.ts — 核心初始化

#### 1.3.1 init() — memoize 包装的一次性初始化

```typescript
export const init = memoize(async (): Promise<void> => {
  // ...
});
```

**为什么用 memoize？** init() 可能从多个路径被调用（preAction hook、子命令handler、SDK 入口等），memoize 确保只执行一次，后续调用直接返回缓存的 Promise。

**执行流程深度分析**：

**阶段 A — 配置与环境变量**（第 62-84 行）：

```typescript
enableConfigs();                          // [A1] 验证并启用配置系统
applySafeConfigEnvironmentVariables();    // [A2] 只应用安全的环境变量
applyExtraCACertsFromConfig();            // [A3] CA 证书（必须在首次 TLS 握手前）
```

- `enableConfigs()` 验证所有配置文件的格式和完整性。如果发现 `ConfigParseError`，在非交互模式下输出错误到 stderr 并退出；在交互模式下动态 import `InvalidConfigDialog` 展示修复界面。注意注释：`showInvalidConfigDialog is dynamically imported in the error path to avoid loading React at init`
- `applySafeConfigEnvironmentVariables()` 只应用"信任前安全"的变量。完整的 `applyConfigEnvironmentVariables()`（包含 LD_PRELOAD、PATH 等危险变量）要等信任建立后才执行
- `applyExtraCACertsFromConfig()` 必须在任何 TLS 连接之前执行。注释特别提到 Bun 的行为：`Bun caches the TLS cert store at boot via BoringSSL, so this must happen before the first TLS handshake`

**阶段 B — 异步后台任务火发**（第 94-118 行）：

```typescript
// [B1] 1P 事件日志初始化
void Promise.all([
  import('../services/analytics/firstPartyEventLogger.js'),
  import('../services/analytics/growthbook.js'),
]).then(([fp, gb]) => {
  fp.initialize1PEventLogging();
  gb.onGrowthBookRefresh(() => {
    void fp.reinitialize1PEventLoggingIfConfigChanged();
  });
});

// [B2] OAuth 账户信息填充
void populateOAuthAccountInfoIfNeeded();

// [B3] JetBrains IDE 检测
void initJetBrainsDetection();

// [B4] GitHub 仓库检测
void detectCurrentRepository();
```

所有 `void` 前缀的调用都是"fire-and-forget"——启动异步任务但不等待完成。这些任务的结果通过全局缓存在后续需要时消费。

**B1 的精妙设计**：使用 `Promise.all` 并行加载 firstPartyEventLogger 和 growthbook 两个模块，然后建立 `onGrowthBookRefresh` 回调链。注释解释：`growthbook.js is already in the module cache by this point (firstPartyEventLogger imports it)`——也就是说 growthbook 的模块实际上在 firstPartyEventLogger 的 import 过程中就被加载了，这里的 `import` 只是获取引用，零额外开销。

**阶段 C — 网络配置与预连接**（第 134-159 行）：

```typescript
configureGlobalMTLS();         // [C1] mTLS 证书配置
configureGlobalAgents();       // [C2] HTTP 代理配置
preconnectAnthropicApi();      // [C3] TCP+TLS 预连接

// 仅 CCR 环境：初始化上游代理中继
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

**`preconnectAnthropicApi()` 的精确时序要求**：

注释非常详细：

> Preconnect to the Anthropic API -- overlap TCP+TLS handshake (~100-200ms) with the ~100ms of action-handler work before the API request. After CA certs + proxy agents are configured so the warmed connection uses the right transport. Fire-and-forget; skipped for proxy/mTLS/unix/cloud-provider where the SDK's dispatcher wouldn't reuse the global pool.

这里有三个关键约束：
1. **时序**：必须在 CA 证书和代理配置之后（否则连接使用错误的传输层）
2. **并行窗口**：利用后续 action handler 中约 100ms 的工作时间来隐藏 TCP+TLS 握手的 100-200ms
3. **适用范围**：只在直连模式下有效。代理/mTLS/Unix socket/云提供商模式下，SDK 使用自己的 dispatcher，不会复用全局连接池

**上游代理中继的 fail-open 设计**：CCR 环境的代理初始化使用 try-catch 包裹，失败时仅记录警告并继续。这是容错设计——代理失败不应阻止整个 CLI 启动。

#### 1.3.2 initializeTelemetryAfterTrust() — 信任后遥测初始化

```typescript
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // 特殊路径：SDK/headless + beta tracing → 提前初始化
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(/*...*/);
    }
    // 正常路径：等待远程设置加载后再初始化
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

**双层初始化逻辑**：对于远程管理设置的用户，遥测初始化需要等待远程设置到达（因为远程设置可能包含 OTEL endpoint 配置）。但 SDK + beta tracing 路径需要立即初始化以确保 tracer 在首个 query 之前就绪。`doInitializeTelemetry()` 内部使用 `telemetryInitialized` 布尔标志防止双重初始化。

#### 1.3.3 setMeterState() — 遥测懒加载

```typescript
async function setMeterState(): Promise<void> {
  // Lazy-load instrumentation to defer ~400KB of OpenTelemetry + protobuf
  const { initializeTelemetry } = await import('../utils/telemetry/instrumentation.js');
  const meter = await initializeTelemetry();
  // ...
}
```

OpenTelemetry (~400KB) + protobuf + gRPC exporters (~700KB via @grpc/grpc-js) 总计超过 1MB。延迟加载到遥测实际初始化时才求值，是一个显著的启动优化。

---

### 1.4 setup.ts — 会话级初始化（477 行）

#### 1.4.1 函数签名与参数分析

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

9 个参数涵盖了会话初始化的所有变体：基本路径、权限模式、worktree 配置、tmux 配置、自定义会话 ID、PR 号、消息传递 socket 路径。

#### 1.4.2 UDS 消息服务启动（第 89-102 行）

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

**设计细节**：
- bare 模式下默认跳过，但 `messagingSocketPath !== undefined` 是逃逸口——注释引用了 `#23222 gate pattern`
- `await` 是必要的：socket 绑定后 `$CLAUDE_CODE_MESSAGING_SOCKET` 被导出到 `process.env`，后续 hook（尤其是 SessionStart）可能 spawn 子进程并继承此环境变量
- 这个 await 占了 setup() ~28ms 中的 ~20ms

#### 1.4.3 setCwd() 与 hooks 快照的时序依赖（第 160-168 行）

```typescript
// IMPORTANT: setCwd() must be called before any other code that depends on the cwd
setCwd(cwd)

// Capture hooks configuration snapshot to avoid hidden hook modifications.
// IMPORTANT: Must be called AFTER setCwd() so hooks are loaded from the correct directory
const hooksStart = Date.now()
captureHooksConfigSnapshot()
```

两个 `IMPORTANT` 注释定义了一个严格的时序依赖：
1. `setCwd()` 必须先执行——它设置工作目录，影响所有后续的文件路径解析
2. `captureHooksConfigSnapshot()` 必须在 `setCwd()` 之后——hooks 配置文件位于项目目录中

#### 1.4.4 Worktree 处理（第 176-285 行）

这是 setup() 中最复杂的分支。关键设计决策：

```typescript
// IMPORTANT: this must be called before getCommands(), otherwise /eject won't be available.
if (worktreeEnabled) {
  const hasHook = hasWorktreeCreateHook()
  const inGit = await getIsGit()
  if (!hasHook && !inGit) {
    // 错误退出
  }

  // findCanonicalGitRoot is sync/filesystem-only/memoized; the underlying
  // findGitRoot cache was already warmed by getIsGit() above, so this is ~free.
  const mainRepoRoot = findCanonicalGitRoot(getCwd())
```

注释中的"~free"解释了缓存预热链：`getIsGit()` 内部调用了 `findGitRoot()`，这个结果被 memoize 缓存；随后 `findCanonicalGitRoot()` 复用同一缓存。

Worktree 创建后的设置链（第 271-285 行）也体现了时序敏感性：

```typescript
process.chdir(worktreeSession.worktreePath)
setCwd(worktreeSession.worktreePath)
setOriginalCwd(getCwd())
setProjectRoot(getCwd())
saveWorktreeState(worktreeSession)
clearMemoryFileCaches()          // 清除旧 cwd 的 CLAUDE.md 缓存
updateHooksConfigSnapshot()       // 重新读取新目录的 hooks 配置
```

#### 1.4.5 后台任务与预取管道（第 287-394 行）

**tengu_started 信标的关键位置**（第 371-378 行）：

```typescript
initSinks() // Attach error log + analytics sinks

// Session-success-rate denominator. Emit immediately after the analytics
// sink is attached — before any parsing, fetching, or I/O that could throw.
// inc-3694 (P0 CHANGELOG crash) threw at checkForReleaseNotes below; every
// event after this point was dead. This beacon is the earliest reliable
// "process started" signal for release health monitoring.
logEvent('tengu_started', {})
```

注释引用了一个真实的 P0 事故（inc-3694）：CHANGELOG 解析崩溃导致 `tengu_started` 之后的所有事件丢失。修复方法是将 `tengu_started` 移到尽可能早的位置——在 analytics sink 挂载后立即发送，在任何可能失败的 I/O 之前。

**Attribution hooks 的 setImmediate 延迟**（第 350-361 行）：

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

`setImmediate` 将 git 子进程的 spawn 推迟到下一个事件循环迭代。这避免了 spawn 与首次渲染竞争 CPU 时间。如果在 setup() 的微任务窗口中 spawn，git 子进程会在 REPL 首次渲染期间消耗 CPU，降低首帧渲染速度。

**release notes 检查的阻塞性**（第 386-393 行）：

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

这是 setup() 中少数几个 `await` 的位置之一。只有在有新版本说明时才加载最近活动数据。bare 模式完全跳过。

#### 1.4.6 安全验证：bypass permissions 检查（第 396-442 行）

```typescript
if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
  // 检查 1：禁止 root/sudo（除非在沙箱中）
  if (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)) {
    console.error('--dangerously-skip-permissions cannot be used with root/sudo...');
    process.exit(1);
  }

  // 检查 2：内部版本需要沙箱 + 无网络
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

**多层安全防护**：

1. **root 检查**：防止在 root 权限下跳过权限（除非在 IS_SANDBOX 或 Bubblewrap 沙箱中）
2. **内部版本额外检查**：需要同时满足"在沙箱中"且"无网络访问"
3. **例外路径**：`local-agent` 和 `claude-desktop` 入口跳过检查——它们是可信的 Anthropic 托管启动器，注释引用了 PR #19116 和 apps#29127 作为先例

注意 `Promise.all([getIsDocker(), hasInternetAccess()])` 的并行执行——Docker 检测和网络检测互不依赖，同时执行节省时间。

---

### 1.5 bootstrap/state.ts — 全局状态容器

#### 1.5.1 设计约束

文件顶部有三条醒目的注释作为守护：

```typescript
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
// ... State type definition ...
// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State { ... }
// AND ESPECIALLY HERE
const STATE: State = getInitialState()
```

这种"三重警告"模式在代码库中极为罕见，体现了对全局状态增长的高度警惕。

#### 1.5.2 初始化策略

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

**三个防御性设计**：
1. `typeof process !== 'undefined'`：兼容浏览器 SDK 构建（`package.json` 的 `browser` 字段会替换模块）
2. `realpathSync` + NFC normalize：解析符号链接并统一 Unicode 编码形式，确保路径比较的一致性
3. try-catch 处理 EPERM：macOS CloudStorage 挂载点的 `lstat` 可能因 File Provider 权限而失败

#### 1.5.3 Prompt Cache 友好的"粘性锁存器"

state.ts 中包含多个 `*Latched` 字段：

```typescript
afkModeHeaderLatched: boolean | null      // AFK 模式 beta header
fastModeHeaderLatched: boolean | null     // Fast 模式 beta header
cacheEditingHeaderLatched: boolean | null  // 缓存编辑 beta header
thinkingClearLatched: boolean | null      // thinking 清理锁存
```

这些"粘性锁存器"（sticky-on latch）的设计目的都相同——一旦某个 beta header 首次被激活，即使后续该功能被关闭，header 仍然保持发送。原因是 prompt cache 基于前缀匹配，频繁切换 header 会导致缓存失效。注释举例：`Once fast mode is first enabled, keep sending the header so cooldown enter/exit doesn't double-bust the prompt cache`。

这是一个极为精细的优化——为了避免 Anthropic API 的 prompt cache miss，在客户端引入了状态锁存机制。

#### 1.5.4 switchSession() 的原子性（第 468-479 行）

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

注释引用了 `CC-34` 来解释为什么 `sessionId` 和 `sessionProjectDir` 必须在同一个函数中一起修改：如果它们有独立的 setter，两次调用之间的时间窗口可能导致不一致状态。

---

### 1.6 utils/startupProfiler.ts — 启动性能分析

#### 1.6.1 采样策略

```typescript
const STATSIG_SAMPLE_RATE = 0.005  // 0.5%
const STATSIG_LOGGING_SAMPLED =
  process.env.USER_TYPE === 'ant' || Math.random() < STATSIG_SAMPLE_RATE
const SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED
```

**双层采样**：
- 内部用户（ant）：100% 采样
- 外部用户：0.5% 采样
- 采样决策在模块加载时做出一次，`Math.random()` 只调用一次

**性能影响**：未被采样的 99.5% 外部用户中，`profileCheckpoint()` 是一个空函数：

```typescript
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return  // 未采样时，成本仅为一次条件判断
  // ...
}
```

#### 1.6.2 Phase 定义

```typescript
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time:   ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time:  ['cli_entry', 'main_after_run'],
} as const
```

这四个阶段覆盖了启动路径的关键段。`import_time` 测量模块评估耗时，是最容易膨胀的段——每添加一个新 import 都会增加这个值。

---

## 二、启动时序图（阻塞/非阻塞标注版）

```
时间轴 (近似值):

0ms     cli.tsx 加载
        ├── [SYNC] 环境变量预设 (COREPACK, NODE_OPTIONS, 消融基线)    ~0ms
        ├── [SYNC] --version 快速路径检查                              ~0ms
        └── [SYNC] 其他快速路径检查 (daemon, bridge, bg...)            ~1ms

~2ms    [ASYNC] await import('earlyInput.js')
        └── startCapturingEarlyInput() — 开始缓冲用户键入

~3ms    [ASYNC] await import('../main.js') ← 触发以下链
        │
        ├── main.tsx 模块求值开始
        │   ├── [SYNC→ASYNC] profileCheckpoint('main_tsx_entry')        ~0ms
        │   ├── [SYNC→ASYNC] startMdmRawRead() → spawn plutil 子进程   ~0ms (spawn 是非阻塞)
        │   ├── [SYNC→ASYNC] startKeychainPrefetch() → spawn security   ~0ms (spawn 是非阻塞)
        │   │       ├── [PARALLEL BG] OAuth keychain read               ~32ms
        │   │       └── [PARALLEL BG] Legacy API key keychain read      ~33ms
        │   │
        │   └── ~180 行静态 import 的求值                              ~132ms
        │       ├── 中间：MDM 子进程完成                                (约 ~20ms 内)
        │       └── 中间：Keychain 子进程完成                           (约 ~33ms 内)

~135ms  profileCheckpoint('main_tsx_imports_loaded')
        └── [SYNC] isBeingDebugged() 检查 + process.exit(1)           ~0ms

~137ms  main() 函数开始
        ├── [SYNC] NoDefaultCurrentDirectoryInExePath 设置              ~0ms
        ├── [SYNC] initializeWarningHandler()                           ~0ms
        ├── [SYNC] 注册 SIGINT/exit 处理器                             ~0ms
        ├── [SYNC→ASYNC] cc:// URL 解析与 argv 改写                    ~0-5ms
        ├── [SYNC→ASYNC] deep link URI 处理                            ~0-5ms
        ├── [SYNC→ASYNC] assistant/ssh 子命令解析                      ~0-2ms
        ├── [SYNC] 交互性检测 + 客户端类型确定                          ~0ms
        └── [SYNC] eagerLoadSettings()                                  ~1-5ms
            ├── eagerParseCliFlag('--settings')
            └── eagerParseCliFlag('--setting-sources')

~145ms  run() 函数 → Commander 初始化
        └── new CommanderCommand().configureHelp()                      ~1ms

~146ms  preAction hook 触发
        ├── [AWAIT, ~0ms] ensureMdmSettingsLoaded()          ← 子进程已完成
        ├── [AWAIT, ~0ms] ensureKeychainPrefetchCompleted()  ← 子进程已完成
        ├── [AWAIT, ~80ms] init()
        │   ├── [SYNC] enableConfigs()                                  ~5ms
        │   ├── [SYNC] applySafeConfigEnvironmentVariables()            ~3ms
        │   ├── [SYNC] applyExtraCACertsFromConfig()                    ~1ms
        │   ├── [SYNC] setupGracefulShutdown()                          ~1ms
        │   ├── [FIRE-FORGET] initialize1PEventLogging()                (bg)
        │   ├── [FIRE-FORGET] populateOAuthAccountInfoIfNeeded()        (bg)
        │   ├── [FIRE-FORGET] initJetBrainsDetection()                  (bg)
        │   ├── [FIRE-FORGET] detectCurrentRepository()                 (bg)
        │   ├── [SYNC] initializeRemoteManagedSettingsLoadingPromise()  ~0ms
        │   ├── [SYNC] initializePolicyLimitsLoadingPromise()           ~0ms
        │   ├── [SYNC] recordFirstStartTime()                           ~0ms
        │   ├── [SYNC] configureGlobalMTLS()                            ~5ms
        │   ├── [SYNC] configureGlobalAgents()                          ~5ms
        │   ├── [FIRE-FORGET] preconnectAnthropicApi()     ← TCP+TLS 握手开始 (bg)
        │   ├── [AWAIT, CCR-only] initUpstreamProxy()                   ~10ms
        │   ├── [SYNC] setShellIfWindows()                              ~0ms
        │   ├── [SYNC] registerCleanup(shutdownLspServerManager)        ~0ms
        │   └── [AWAIT, if scratchpad] ensureScratchpadDir()            ~5ms
        │
        ├── [AWAIT, ~2ms] import('sinks.js') + initSinks()
        ├── [SYNC] handlePluginDir()                                    ~1ms
        ├── [SYNC] runMigrations()                                      ~3ms
        ├── [FIRE-FORGET] loadRemoteManagedSettings()                   (bg)
        ├── [FIRE-FORGET] loadPolicyLimits()                            (bg)
        └── [FIRE-FORGET] uploadUserSettingsInBackground()              (bg)

~230ms  action handler 开始
        ├── [SYNC] --bare 环境变量设置                                  ~0ms
        ├── [SYNC] Kairos/Assistant 模式判断与初始化                     ~0-10ms
        ├── [SYNC] 权限模式解析                                         ~2ms
        ├── [SYNC] MCP 配置解析（JSON/文件）                             ~5ms
        ├── [SYNC] 工具权限上下文初始化                                  ~3ms
        │
        ├── [SYNC, <1ms] initBuiltinPlugins() + initBundledSkills()
        │
        ├── ┌─── [PARALLEL] ────────────────────────────┐
        │   │ setup()              ~28ms                 │
        │   │  ├── [AWAIT] startUdsMessaging()  ~20ms    │
        │   │  ├── [AWAIT] teammateModeSnapshot ~1ms     │
        │   │  ├── [AWAIT] terminalBackupRestore ~2ms    │
        │   │  ├── [SYNC] setCwd() + captureHooks ~2ms   │
        │   │  ├── [SYNC] initFileChangedWatcher ~1ms    │
        │   │  ├── [SYNC] initSessionMemory() ~0ms       │
        │   │  ├── [SYNC] initContextCollapse() ~0ms     │
        │   │  ├── [FIRE-FORGET] lockCurrentVersion()    │
        │   │  ├── [FIRE-FORGET] getCommands(prefetch)   │
        │   │  ├── [FIRE-FORGET] loadPluginHooks()       │
        │   │  ├── [setImmediate] attribution hooks      │
        │   │  ├── [SYNC] initSinks() + tengu_started    │
        │   │  ├── [FIRE-FORGET] prefetchApiKey()        │
        │   │  └── [AWAIT] checkForReleaseNotes()        │
        │   │                                            │
        │   │ getCommands(cwd)     ~10ms                 │
        │   │ getAgentDefs(cwd)    ~10ms                 │
        │   └─── [PARALLEL] ────────────────────────────┘
        │
        ├── [AWAIT] setupPromise 完成                                   +28ms
        │   ├── [非交互] applyConfigEnvironmentVariables()
        │   ├── [非交互] void getSystemContext()
        │   └── [非交互] void getUserContext()
        │
        └── [AWAIT] Promise.all([commands, agents])                     +0-5ms

~265ms  交互模式分支
        ├── [AWAIT] createRoot() (Ink 渲染引擎初始化)                    ~5ms
        ├── [SYNC] logEvent('tengu_timer', startup)
        ├── [AWAIT] showSetupScreens()
        │   ├── 信任对话框                                              (用户交互，0-∞ms)
        │   ├── OAuth 登录                                              (用户交互)
        │   └── 入门引导                                                (用户交互)
        │
        ├── [PARALLEL, bg] mcpConfigPromise (配置 I/O 在此期间完成)
        ├── [PARALLEL, bg] claudeaiConfigPromise (仅 -p 模式)
        │
        ├── [AWAIT] mcpConfigPromise 解析
        ├── [FIRE-FORGET] prefetchAllMcpResources()
        ├── [FIRE-FORGET] processSessionStartHooks('startup')
        │
        └── 各种验证 (org, settings, quota...)

~350ms+ launchRepl() 或 runHeadless()
        └── [FIRE-FORGET] startDeferredPrefetches()
            ├── initUser()
            ├── getUserContext()
            ├── prefetchSystemContextIfSafe()
            ├── getRelevantTips()
            ├── countFilesRoundedRg(3s timeout)
            ├── initializeAnalyticsGates()
            ├── prefetchOfficialMcpUrls()
            ├── refreshModelCapabilities()
            ├── settingsChangeDetector.initialize()
            ├── skillChangeDetector.initialize()
            └── [ant-only] eventLoopStallDetector
```

---

## 三、设计权衡分析

### 3.1 模块顶层副作用 vs 纯模块

**选择**：在 main.tsx 第 12-20 行使用顶层副作用启动子进程。

**权衡**：
- **收益**：隐藏了 65ms 的 keychain 读取和 MDM 子进程启动，几乎零增量成本
- **代价**：违反了"纯模块"原则（import 不应有副作用），增加了模块依赖图的隐式耦合
- **缓解**：通过 `eslint-disable` 注释显式标注，且注释详细解释了时序要求
- **业界对比**：这种技术在 CLI 工具中非常罕见。大多数 CLI 框架（如 oclif、yargs）依赖 lazy-loading 而非顶层副作用。Chrome DevTools 的启动优化有类似的"import-time side-effect"模式

### 3.2 Commander preAction Hook vs 直接初始化

**选择**：将 init() 放在 Commander 的 preAction hook 而非顶层调用。

**权衡**：
- **收益**：`claude --help` 不触发初始化，节省 ~100ms
- **代价**：初始化逻辑与命令执行耦合，增加了理解难度
- **业界对比**：oclif 框架使用类似的 `init()` hook 模式。Commander 的 preAction 是更轻量的方案

### 3.3 并行 setup() vs 串行执行

**选择**：setup() 与 getCommands()/getAgentDefs() 并行执行。

**权衡**：
- **收益**：隐藏了 setup() 的 ~28ms（UDS socket 绑定）
- **代价**：引入了竞态可能性（已通过移出 initBundledSkills 修复）
- **代价**：worktree 模式下必须放弃并行（setup 会 chdir）
- **代码复杂度**：需要 `.catch(() => {})` 抑制瞬态 unhandledRejection

### 3.4 --bare 模式的全系统渗透 vs 独立路径

**选择**：通过 `isBareMode()` 检查在多个位置跳过非核心工作，而非创建独立的 bare 启动路径。

**权衡**：
- **收益**：避免了代码重复，bare 模式自然享受所有核心路径的改进
- **代价**：`isBareMode()` 检查散布在代码各处，增加了维护心智负担
- **性能数据**：setup.ts 中注释标注了具体节省量，如"attribution hook stat check (measured) — 49ms"

### 3.5 Content-hash 临时文件 vs 随机 UUID

**选择**：--settings JSON 使用内容哈希路径而非随机 UUID。

**权衡**：
- **收益**：避免 prompt cache 失效（12 倍 input token 成本差异）
- **代价**：同内容不同进程共享临时文件——理论上可能有并发写入问题（实际上文件内容相同，所以无害）
- **独创性**：这是一个非常罕见的优化。将 API 的 prompt cache 行为反向映射到本地文件路径生成策略，体现了对整个系统端到端性能的深刻理解

### 3.6 粘性锁存器 vs 动态 header

**选择**：beta header 使用"一旦激活永不关闭"的锁存策略。

**权衡**：
- **收益**：避免了 prompt cache miss（~50-70K token 的缓存价值）
- **代价**：功能状态变更不完全反映在 API 请求中（header 说"开启"但实际可能已关闭）
- **安全性**：header 仅影响计费/路由，不影响功能行为（功能通过 `body.speed` 等参数控制）

---

## 四、值得学习的模式

### 4.1 Import-time Parallel Prefetch（导入时并行预取）

利用 ES 模块求值的确定性时序，在 import 链评估期间并行执行子进程。这是对 JavaScript 执行模型的深刻理解：

```
import A → A 的顶层代码执行（同步）
import B → B 的顶层代码执行（同步）
... 135ms of synchronous module evaluation ...
```

在这 135ms 内，被 `startMdmRawRead()` 和 `startKeychainPrefetch()` spawn 的子进程在操作系统级别并行运行。Node.js/Bun 的事件循环在模块求值完成前不会 poll，但子进程是独立进程，不受事件循环约束。

### 4.2 Memoize + Fire-and-Forget + Await-Later 模式

多个函数使用相同的三阶段模式：
1. **Fire**：在时序上最早的合理点启动异步操作（`void getSystemContext()`）
2. **Forget**：不等待结果，继续执行后续同步工作
3. **Await Later**：在真正需要结果时 await（由于 memoize，返回同一 Promise）

这个模式在 `getCommands()`、`getSystemContext()`、`getUserContext()` 等函数中反复出现。

### 4.3 Feature Gate + DCE（Dead Code Elimination）联合使用

```typescript
const module = feature('FLAG') ? require('./module.js') : null;
```

`feature()` 在构建时求值，`require` 只在条件为 true 时存在于 bundle 中。这比运行时条件 import 更彻底——模块本身从 bundle 中消失。每个被 DCE 消除的模块都直接减少了 bundle 大小和首次 import 的评估时间。

### 4.4 注释中的"Bug 考古学"

代码中的注释不仅解释了当前逻辑，还记录了问题的历史。例如：

- `inc-3694 (P0 CHANGELOG crash)`——真实事故编号
- `gh-33508`——GitHub issue 编号
- `CC-34`——内部 bug 编号
- `Previously ran inside setup() after ~20ms of await points`——修复前的状态

这种"考古学注释"对于后续维护者理解代码为何如此编写至关重要。它们回答了"为什么不用更简单的方式？"这个问题——因为更简单的方式已经被尝试过并且失败了。

### 4.5 多层安全边界

系统严格区分"信任前"和"信任后"操作：

| 操作类型 | 信任要求 | 代码位置 |
|---------|---------|---------|
| applySafeConfigEnvironmentVariables() | 无（安全子集） | init.ts:74 |
| applyConfigEnvironmentVariables() | 需要信任 | main.tsx:1965 (非交互) / 信任对话框后 (交互) |
| MCP 配置读取 | 无（纯文件 I/O） | main.tsx:1800-1814 |
| MCP 资源预取 | 需要信任（涉及代码执行） | main.tsx:2404+ |
| prefetchSystemContextIfSafe() | 检查信任状态 | main.tsx:360-380 |
| LSP 管理器初始化 | 需要信任 | main.tsx:2321 |
| git 命令执行 | 需要信任（git hooks 可执行任意代码） | 多处 |

这种分层信任模型确保了即使在恶意仓库中运行，未经用户确认前不会执行危险操作。

---

## 五、代码质量评价

### 5.1 优雅之处

1. **注释质量极高**：几乎每个非显而易见的决策都有详细注释，包括性能数据（ms 数、百分比）、bug 引用、时序依赖说明
2. **性能意识贯穿始终**：从 import 级别的子进程并行到 API prompt cache 友好的临时文件命名，体现了对整个请求链条的端到端优化思维
3. **安全边界清晰**：信任前/信任后的操作区分严格，每个安全决策都有注释说明
4. **错误处理一致**：fire-and-forget 使用 `void` + `.catch()`，有意的忽略使用 try-catch + 注释

### 5.2 技术债务

1. **main.tsx 体量过大**：4683 行的单文件承担了太多职责。action handler 单独就有 ~2800 行，应拆分为独立模块
2. **9 参数 setup() 函数**：参数列表过长，暗示职责可能过于集中。可考虑使用配置对象模式
3. **散落的 `"external" === 'ant'` 检查**：构建时字符串替换虽有效，但缺乏类型安全。如果误写为 `"external" == 'ant'` 不会有编译错误
4. **TODO 痕迹**：`main.tsx:2355` 的 `TODO: Consolidate other prefetches into a single bootstrap request` 表明当前的多请求预取模式尚待优化
5. **`process.exit()` 使用过多**：setup.ts 和 main.tsx 中有大量直接 `process.exit(1)` 调用。虽然 CLI 中这是常见做法，但不利于测试和优雅清理

### 5.3 与业界对比

| 优化技术 | Claude Code | 其他 CLI 工具 |
|---------|------------|--------------|
| Import-time 子进程预取 | 有（MDM + Keychain） | 极罕见 |
| 快速路径短路 | 有（10+ 快速路径） | 常见（如 git、docker） |
| preAction hook 延迟初始化 | 有 | oclif 有类似设计 |
| API prompt cache 友好路径 | 有（content-hash） | 未见先例 |
| 粘性 beta header 锁存 | 有 | 未见先例 |
| 构建时 feature flag + DCE | 有 | Rust CLI 有类似的 cargo features |
| 遥测采样决策 | 模块加载时一次性 | 常见 |
| 双层信任模型 | 有（safe vs full env vars） | 少见（通常全有或全无） |

Claude Code 在启动优化上的投入程度远超大多数 CLI 工具。这反映了其使用场景的独特性——作为一个需要频繁重启、首次响应延迟敏感的交互式 AI 编程助手，每毫秒的启动优化都能被用户感知。Prompt cache 和 beta header 锁存等优化更是针对 LLM API 的独特挑战，在传统 CLI 工具中没有对应需求。
