# 10 - Feature Flags 与隐藏功能 (Deep Dive)

## 概述

Claude Code 采用精密的**三层 Feature Flag 架构**：构建时 `feature('FLAG')` (Bun bundler dead-code elimination)、运行时 GrowthBook Remote Eval (tengu\_\* 命名空间)、环境变量 (`USER_TYPE`/`CLAUDE_CODE_*`)。逐文件精读 `constants/` 全部 21 个文件、`buddy/` 全部 6 个文件、`voice/`、`moreright/`、GrowthBook 集成及 undercover 系统后，以下为完整分析。

---

## 一、88 个构建时 Feature Flag 完整分类清单

通过 `feature('...')` 正则搜索全量提取（去重后 88 个唯一 flag）：

### 1.1 KAIROS 助理模式族 (7 个)

| Flag | 推测用途 | 代码佐证 |
|------|---------|---------|
| `KAIROS` | 助理/后台代理主开关 | `main.tsx` 中启用 assistantModule、BriefTool、SleepTool、proactive 系统 |
| `KAIROS_BRIEF` | Brief 精简输出独立发布 | 与 KAIROS OR-gate：`feature('KAIROS') \|\| feature('KAIROS_BRIEF')` |
| `KAIROS_CHANNELS` | MCP 频道通知/消息接收 | `channelNotification.ts`：接收外部频道消息 |
| `KAIROS_DREAM` | 记忆整合"做梦"系统 | `skills/bundled/index.ts`：注册 /dream 技能 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub PR 订阅 | `commands.ts`：注册 subscribePr 命令 |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知 | `tools.ts`：注册 PushNotificationTool |
| `PROACTIVE` | 主动干预（与 KAIROS 共存） | 始终以 `feature('PROACTIVE') \|\| feature('KAIROS')` 形式出现 |

### 1.2 远程/Bridge/CCR 模式 (5 个)

| Flag | 推测用途 | 代码佐证 |
|------|---------|---------|
| `BRIDGE_MODE` | CCR 远程桥接主开关 | `bridgeEnabled.ts`：6 次独立引用，控制所有 bridge 路径 |
| `CCR_AUTO_CONNECT` | 远程自动连接 | `bridgeEnabled.ts:186` |
| `CCR_MIRROR` | 远程镜像同步 | `remoteBridgeCore.ts`：outboundOnly 分支 |
| `CCR_REMOTE_SETUP` | 远程环境配置 | 远程会话初始化流程 |
| `SSH_REMOTE` | SSH 远程连接 | 远程开发环境支持 |

### 1.3 Agent/多代理系统 (8 个)

| Flag | 推测用途 | 代码佐证 |
|------|---------|---------|
| `COORDINATOR_MODE` | 协调器模式（纯调度） | `REPL.tsx:119`：getCoordinatorUserContext |
| `FORK_SUBAGENT` | 后台分叉子代理 | `forkSubagent.ts`：后台独立运行 |
| `VERIFICATION_AGENT` | 对抗性验证代理 | `prompts.ts`：spawn verifier before completion |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 探索/规划内置代理 | 搜索与规划专用子代理 |
| `AGENT_TRIGGERS` | 代理触发器/定时任务 | `tools.ts`：Cron 工具注册 |
| `AGENT_TRIGGERS_REMOTE` | 远程代理触发器 | 远程环境的定时任务 |
| `AGENT_MEMORY_SNAPSHOT` | 代理记忆快照 | 子代理上下文传递 |
| `WORKFLOW_SCRIPTS` | 工作流脚本执行 | `tools.ts`：WorkflowTool 注册 |

### 1.4 工具/功能增强 (17 个)

| Flag | 推测用途 |
|------|---------|
| `VOICE_MODE` | 语音模式（实时 STT/TTS） |
| `WEB_BROWSER_TOOL` | 内嵌浏览器工具 |
| `MONITOR_TOOL` | 进程监控工具 |
| `TERMINAL_PANEL` | 终端面板 UI |
| `MCP_RICH_OUTPUT` | MCP 富文本输出 |
| `MCP_SKILLS` | MCP 技能注册 |
| `QUICK_SEARCH` | 快速搜索 |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 |
| `REVIEW_ARTIFACT` | 代码审查产物 |
| `TEMPLATES` | 项目模板系统 |
| `TREE_SITTER_BASH` | Tree-sitter Bash 解析 |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter 影子模式（对比实验） |
| `BASH_CLASSIFIER` | Bash 命令分类器 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 |
| `NOTEBOOK_EDIT_TOOL` | (隐含) Jupyter 编辑 |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能搜索实验 |
| `SKILL_IMPROVEMENT` | 技能自改进 |

### 1.5 上下文/压缩/记忆 (8 个)

| Flag | 推测用途 |
|------|---------|
| `CACHED_MICROCOMPACT` | 缓存微压缩配置 |
| `REACTIVE_COMPACT` | 响应式压缩 |
| `COMPACTION_REMINDERS` | 压缩提醒 |
| `CONTEXT_COLLAPSE` | 上下文折叠 |
| `EXTRACT_MEMORIES` | 自动提取记忆 |
| `HISTORY_PICKER` | 历史会话选择器 |
| `HISTORY_SNIP` | 历史片段截取 |
| `AWAY_SUMMARY` | 离开摘要（回来后补报） |

### 1.6 输出/UI (7 个)

| Flag | 推测用途 |
|------|---------|
| `BUDDY` | 电子宠物伴侣系统 |
| `MESSAGE_ACTIONS` | 消息操作菜单 |
| `BG_SESSIONS` | 后台会话 |
| `STREAMLINED_OUTPUT` | 精简输出 |
| `ULTRAPLAN` | 超级规划模式（远程并行） |
| `ULTRATHINK` | 超级思考模式 |
| `AUTO_THEME` | 自动主题切换 |

### 1.7 安全/遥测/基础设施 (17 个)

| Flag | 推测用途 |
|------|---------|
| `NATIVE_CLIENT_ATTESTATION` | 原生客户端认证（Zig 实现 hash） |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 |
| `TRANSCRIPT_CLASSIFIER` | 转录分类器（AFK 模式） |
| `CONNECTOR_TEXT` | 连接器文本摘要 |
| `COMMIT_ATTRIBUTION` | 提交归因 |
| `TOKEN_BUDGET` | Token 预算控制 |
| `SHOT_STATS` | 单次统计 |
| `ABLATION_BASELINE` | 消融基线实验 |
| `PERFETTO_TRACING` | Perfetto 性能追踪 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志 |
| `ENHANCED_TELEMETRY_BETA` | 增强遥测 Beta |
| `COWORKER_TYPE_TELEMETRY` | 协作者类型遥测 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测 |
| `PROMPT_CACHE_BREAK_DETECTION` | 缓存破坏检测 |
| `HARD_FAIL` | 硬失败模式 |
| `UNATTENDED_RETRY` | 无人值守重试 |
| `BREAK_CACHE_COMMAND` | 缓存清除命令 |

### 1.8 内部/平台 (11 个)

| Flag | 推测用途 |
|------|---------|
| `ALLOW_TEST_VERSIONS` | 允许测试版本 |
| `BUILDING_CLAUDE_APPS` | Claude 应用构建模式 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 环境运行器 |
| `CHICAGO_MCP` | Chicago MCP 部署 |
| `DAEMON` | 守护进程模式 |
| `DIRECT_CONNECT` | 直连模式 |
| `DOWNLOAD_USER_SETTINGS` | 下载用户设置 |
| `UPLOAD_USER_SETTINGS` | 上传用户设置 |
| `DUMP_SYSTEM_PROMPT` | 导出系统提示 |
| `FILE_PERSISTENCE` | 文件持久化 |
| `HOOK_PROMPTS` | Hook 提示注入 |

### 1.9 其他专项 (8 个)

| Flag | 推测用途 |
|------|---------|
| `LODESTONE` | 磁铁石项目（未知） |
| `TORCH` | 火炬项目（未知） |
| `TEAMMEM` | 团队记忆同步 |
| `UDS_INBOX` | Unix Domain Socket 收件箱 |
| `SELF_HOSTED_RUNNER` | 自托管运行器 |
| `RUN_SKILL_GENERATOR` | 技能生成器 |
| `NEW_INIT` | 新初始化流程 |
| `IS_LIBC_GLIBC` / `IS_LIBC_MUSL` | C 库检测（Linux 兼容） |
| `NATIVE_CLIPBOARD_IMAGE` | 原生剪贴板图片 |

---

## 二、KAIROS 助理模式深度解析

### 2.1 子 Flag 协作关系图

```
                    KAIROS (主开关)
                   /    |    \     \
                  /     |     \     \
        KAIROS_BRIEF  KAIROS  KAIROS  KAIROS_GITHUB_WEBHOOKS
        (精简输出)  _CHANNELS _DREAM  (PR 订阅)
                  (频道)   (做梦)
                                \
                         KAIROS_PUSH_NOTIFICATION
                            (推送通知)
```

代码中典型的 OR-gate 模式：

```typescript
// 1. Brief 独立发布但 KAIROS 包含它
feature('KAIROS') || feature('KAIROS_BRIEF')

// 2. 频道消息独立发布
feature('KAIROS') || feature('KAIROS_CHANNELS')

// 3. Proactive 与 KAIROS 共存
feature('PROACTIVE') || feature('KAIROS')
```

**核心逻辑**：KAIROS 是一个"超集"，打开它等于同时启用 Brief、Channels、Proactive 等所有子功能。但每个子功能也可以独立开启用于 A/B 测试。

### 2.2 SleepTool 实现

位于 `tools/SleepTool/prompt.ts`：

```typescript
export const SLEEP_TOOL_PROMPT = `Wait for a specified duration. The user can interrupt the sleep at any time.
Use this when the user tells you to sleep or rest, when you have nothing to do,
or when you're waiting for something.
You may receive <tick> prompts -- these are periodic check-ins.
Look for useful work to do before sleeping.`
```

关键设计：
- 不占用 shell 进程（优于 `Bash(sleep ...)`)
- 可并发调用，不阻塞其他工具
- 收到 `<tick>` 心跳时会检查是否有待处理工作
- 每次唤醒消耗一个 API 调用，但 prompt cache 5 分钟过期

### 2.3 "做梦"(KAIROS_DREAM) 系统工作原理

**入口**：`services/autoDream/autoDream.ts` + `consolidationPrompt.ts`

**触发三重门控（最便宜的先检查）**：

1. **时间门控**：`lastConsolidatedAt` 距今 >= minHours（默认 24 小时）
2. **会话门控**：上次整合后产生的 transcript 数 >= minSessions（默认 5 个）
3. **锁门控**：无其他进程正在整合（文件锁 `.consolidate-lock`，PID + mtime）

**整合流程（4 阶段 prompt）**：

```
Phase 1 -- Orient: ls 记忆目录，读索引，理解现有记忆结构
Phase 2 -- Gather: 搜索最近 transcript JSONL 文件（只 grep 窄词条）
Phase 3 -- Consolidate: 合并新信号到现有主题文件，修正过期事实
Phase 4 -- Prune: 更新索引，保持 <25KB，一行一条 <150 字符
```

**技术实现**：
- 通过 `runForkedAgent()` 派生独立子代理执行
- `DreamTask` 在 UI 底部显示进度条
- `tengu_onyx_plover` GrowthBook flag 控制参数
- 锁机制精巧：mtime 即 lastConsolidatedAt，PID 防重入，HOLDER_STALE_MS=1h 防僵锁

### 2.4 产品方向推断

KAIROS 暗示 Claude Code 正在从"工具"进化为"助理"：
- **Sleep + Tick**：AI 可以长驻后台，定期醒来检查
- **Brief/Chat 模式**：从 full-text 输出转向精简消息
- **Channels**：接收外部消息（Slack、Telegram 等）
- **Push Notification**：主动通知用户
- **Dream**：像人类大脑一样，在"睡眠"中整合记忆
- **GitHub Webhooks**：订阅 PR 事件，长期跟踪项目

这是一个 **"Always-on AI pair programmer"** 的愿景：不是用完就关，而是在后台持续运行，主动感知环境变化，在恰当时机介入。

---

## 三、Buddy 电子宠物完整解剖

### 3.1 18 个物种完整列表

所有物种名通过 `String.fromCharCode()` 编码定义于 `buddy/types.ts`：

| # | 物种 | 十六进制 | ASCII Art 特征 |
|---|------|---------|---------------|
| 1 | duck | 0x64,0x75,0x63,0x6b | `<(. )___` 鸭子 |
| 2 | goose | 0x67,0x6f,0x6f,0x73,0x65 | `(.>` 伸脖子鹅 |
| 3 | blob | 0x62,0x6c,0x6f,0x62 | `.----.` 果冻团 |
| 4 | cat | 0x63,0x61,0x74 | `/\_/\  (  w  )` 猫 |
| 5 | dragon | 0x64,0x72,0x61,0x67,0x6f,0x6e | `/^\  /^\` 双角龙 |
| 6 | octopus | 0x6f,0x63,0x74,0x6f,0x70,0x75,0x73 | `/\/\/\/\` 触手章鱼 |
| 7 | owl | 0x6f,0x77,0x6c | `(.)(.))` 大眼猫头鹰 |
| 8 | penguin | 0x70,0x65,0x6e,0x67,0x75,0x69,0x6e | `(.>.)` 企鹅 |
| 9 | turtle | 0x74,0x75,0x72,0x74,0x6c,0x65 | `[______]` 龟壳 |
| 10 | snail | 0x73,0x6e,0x61,0x69,0x6c | `.--.  ( @ )` 蜗牛 |
| 11 | ghost | 0x67,0x68,0x6f,0x73,0x74 | `~\`~\`\`~\`~` 幽灵 |
| 12 | axolotl | 0x61,0x78,0x6f,0x6c,0x6f,0x74,0x6c | `}~(. .. .)~{` 六鳃蝾螈 |
| 13 | capybara | 0x63,0x61,0x70,0x79,0x62,0x61,0x72,0x61 | `n______n  (   oo   )` 水豚 |
| 14 | cactus | 0x63,0x61,0x63,0x74,0x75,0x73 | `n  ____  n` 仙人掌 |
| 15 | robot | 0x72,0x6f,0x62,0x6f,0x74 | `.[||].  [ ==== ]` 机器人 |
| 16 | rabbit | 0x72,0x61,0x62,0x62,0x69,0x74 | `(\__/)  =(  ..  )=` 兔子 |
| 17 | mushroom | 0x6d,0x75,0x73,0x68,0x72,0x6f,0x6f,0x6d | `.-o-OO-o-.` 蘑菇 |
| 18 | chonk | 0x63,0x68,0x6f,0x6e,0x6b | `/\    /\  (   ..   )` 胖猫 |

### 3.2 为什么用 `String.fromCharCode` 编码

源码注释一语道破：

```typescript
// One species name collides with a model-codename canary in excluded-strings.txt.
// The check greps build output (not source), so runtime-constructing the value keeps
// the literal out of the bundle while the check stays armed for the actual codename.
// All species encoded uniformly; `as` casts are type-position only (erased pre-bundle).
```

**真正原因**：Anthropic 有一个 `excluded-strings.txt` 文件，构建系统会 grep 产物检查是否泄露了内部模型代号。其中一个物种名（很可能是 **capybara** -- 即 Anthropic 内部的某个模型代号）与这个黑名单冲突。为了不触发 canary 检测，所有物种都统一用 `fromCharCode` 编码。这也证实了 "Capybara" 确实是 Anthropic 内部的一个模型代号（代码注释 `@[MODEL LAUNCH]: Update comment writing for Capybara` 多次出现）。

### 3.3 稀有度权重系统

```typescript
export const RARITY_WEIGHTS = {
  common:    60,  // 60%
  uncommon:  25,  // 25%
  rare:      10,  // 10%
  epic:       4,  //  4%
  legendary:  1,  //  1%
}
```

稀有度影响：
- **属性底板**：common 5 / uncommon 15 / rare 25 / epic 35 / legendary 50
- **帽子**：common 无帽子，其他稀有度随机分配帽子
- **闪光**：任何稀有度都有 1% 概率 shiny

### 3.4 属性系统

5 个属性：`DEBUGGING`、`PATIENCE`、`CHAOS`、`WISDOM`、`SNARK`

生成规则：
- 随机选一个 peak stat（+50 基础 + 0-30 随机）
- 随机选一个 dump stat（底板 -10 + 0-15 随机）
- 其余属性 = 底板 + 0-40 随机

### 3.5 帽子系统

8 种帽子（common 不分配）：`none`、`crown`、`tophat`、`propeller`、`halo`、`wizard`、`beanie`、`tinyduck`

对应的 ASCII art 行：
```
crown:     \^^^/
tophat:    [___]
propeller:  -+-
halo:      (   )
wizard:     /^\
beanie:    (___)
tinyduck:   ,>
```

### 3.6 April 1st 发布策略

```typescript
// Teaser window: April 1-7, 2026 only. Command stays live forever after.
export function isBuddyTeaserWindow(): boolean {
  if ("external" === 'ant') return true;  // 内部总是可见
  const d = new Date();
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7;
}
export function isBuddyLive(): boolean {
  return d.getFullYear() > 2026 || (d.getFullYear() === 2026 && d.getMonth() >= 3);
}
```

策略：
- **2026 年 4 月 1-7 日**：Teaser 窗口，未孵化用户看到彩虹色 `/buddy` 通知（15 秒后消失）
- **4 月 1 日后永久生效**：`isBuddyLive()` 返回 true
- **使用本地时间**，不是 UTC -- 注释解释：跨时区 24 小时滚动波，制造持续的 Twitter 话题（而非 UTC 午夜单一峰值），同时减轻 soul-gen 负载
- **内部用户**（`USER_TYPE === 'ant'`）始终可用

### 3.7 确定性种子系统

```typescript
const SALT = 'friend-2026-401'  // 暗示 April 1st (4/01)

export function roll(userId: string): Roll {
  const key = userId + SALT
  const rng = mulberry32(hashString(key))
  // 每个用户的伴侣完全由 userId 决定
}
```

Bones（骨架）从 hash(userId) 确定性派生，永不持久化；Soul（名字、性格）由模型生成，存储在 config 中。这意味着用户无法通过编辑配置文件来伪造稀有度。

---

## 四、Undercover 卧底模式

### 4.1 完整触发逻辑

位于 `utils/undercover.ts`：

```typescript
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    // 强制开启
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true
    // 自动模式：除非确认在内部仓库，否则开启
    return getRepoClassCached() !== 'internal'
  }
  return false  // 外部构建永远 false
}
```

**三种状态**：
1. `CLAUDE_CODE_UNDERCOVER=1` -- 强制 ON（即使在内部仓库）
2. 自动模式（默认）-- 仅当 `getRepoClassCached() === 'internal'` 时 OFF
3. **没有 force-OFF** -- 这是故意的安全设计

### 4.2 注入的完整 Prompt

```
## UNDERCOVER MODE -- CRITICAL

You are operating UNDERCOVER in a PUBLIC/OPEN-SOURCE repository. Your commit
messages, PR titles, and PR bodies MUST NOT contain ANY Anthropic-internal
information. Do not blow your cover.

NEVER include in commit messages or PR descriptions:
- Internal model codenames (animal names like Capybara, Tengu, etc.)
- Unreleased model version numbers (e.g., opus-4-7, sonnet-4-8)
- Internal repo or project names (e.g., claude-cli-internal, anthropics/...)
- Internal tooling, Slack channels, or short links (e.g., go/cc, #claude-code-...)
- The phrase "Claude Code" or any mention that you are an AI
- Any hint of what model or version you are
- Co-Authored-By lines or any other attribution

Write commit messages as a human developer would...
```

### 4.3 无法关闭的技术原因

源码注释明确说明：

> There is NO force-OFF. This guards against model codename leaks -- if we're not confident we're in an internal repo, we stay undercover.

设计理念：安全默认（safe default is ON）。由于 Claude 可能从非 git 目录（如 `/tmp`）push 到公开仓库，无法可靠判断目标是否为公开仓库时，宁可多保护。

### 4.4 影响范围

Undercover 模式会影响：
- `commit.ts` / `commit-push-pr.ts` -- 提交消息和 PR 内容
- `prompts.ts` -- 系统提示中的模型自我认知
- `PromptInputFooter.tsx` -- UI 显示
- `attribution.ts` -- 归因信息
- `setup.ts` -- 初始化时的仓库分类

### 4.5 伦理分析

这是一个有趣的设计：Anthropic 的内部员工用 Claude Code 向公开仓库贡献代码时，AI 被指示**隐藏自己是 AI 的事实**。这引发了关于 AI 生成代码透明度的讨论。从 Anthropic 的角度，这主要是为了防止内部代号泄露（安全考量），但副作用是模糊了人类/AI 的贡献边界。

---

## 五、GrowthBook 集成深度

### 5.1 SDK Key 三分策略

`constants/keys.ts`：

```typescript
export function getGrowthBookClientKey(): string {
  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'   // 内部开发环境
      : 'sdk-xRVcrliHIlrg4og4'   // 内部生产环境
    : 'sdk-zAZezfDKGoZuXXKe'     // 外部用户
}
```

三级用途：
1. **外部** (sdk-zAZ...)：面向所有公开用户的功能配置
2. **内部生产** (sdk-xRV...)：Anthropic 员工的日常配置
3. **内部开发** (sdk-yZQ...)：启用 `ENABLE_GROWTHBOOK_DEV` 后的实验环境

### 5.2 三级优先级实现

`services/analytics/growthbook.ts` 中值解析的优先级链：

```
1. 环境变量 CLAUDE_INTERNAL_FC_OVERRIDES (JSON, ant-only)
   |-- 最高优先级，用于 eval harness 确定性测试
2. 本地配置 getGlobalConfig().growthBookOverrides (/config Gates tab)
   |-- ant-only，可运行时修改
3. 远程评估 remoteEvalFeatureValues (GrowthBook Remote Eval)
   |-- 从服务器拉取，实时生效
4. 磁盘缓存 cachedGrowthBookFeatures (~/.claude.json)
   |-- 网络不可用时的 fallback
5. 硬编码默认值 (函数调用处的 defaultValue 参数)
```

### 5.3 磁盘缓存机制

```typescript
function syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) return
  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}
```

关键设计：
- **全量替换**（非合并）：服务端删除的 flag 会从本地消失
- **仅在成功时写入**：超时/失败路径不会写入，防止"毒化"缓存
- **空 payload 保护**：`Object.keys(payload.features).length === 0` 会跳过，防止空对象覆盖
- 存储位置：`~/.claude.json` 的 `cachedGrowthBookFeatures` 字段

### 5.4 Exposure Logging

```typescript
// 去重：每个 feature 每会话最多 log 一次
const loggedExposures = new Set<string>()
// 延迟 log：init 完成前访问的 feature 记入 pendingExposures
const pendingExposures = new Set<string>()
```

---

## 六、"Tengu" 项目代号全解

**"Tengu"（天狗）是 Claude Code 的内部代号**。证据遍布整个代码库：

### 6.1 遥测事件命名

所有一级遥测事件都以 `tengu_` 为前缀：

```
tengu_init, tengu_exit, tengu_started
tengu_api_error, tengu_api_success, tengu_api_query
tengu_tool_use_success, tengu_tool_use_error
tengu_oauth_success, tengu_oauth_error
tengu_cancel, tengu_compact_failed, tengu_flicker
tengu_voice_recording_started, tengu_voice_toggled
tengu_session_resumed, tengu_continue
tengu_brief_mode_enabled, tengu_brief_send
tengu_team_mem_sync_pull, tengu_team_mem_sync_push
```

### 6.2 GrowthBook Feature Flag 命名

运行时配置同样使用 `tengu_` 前缀，后跟随机词组（代号风格）：

| Flag | 用途 |
|------|------|
| `tengu_attribution_header` | 归因头开关 |
| `tengu_frond_boric` | 遥测 sink killswitch |
| `tengu_log_datadog_events` | Datadog 事件门控 |
| `tengu_event_sampling_config` | 事件采样配置 |
| `tengu_1p_event_batch_config` | 一方事件批处理配置 |
| `tengu_cobalt_frost` | Nova 3 语音引擎门控 |
| `tengu_onyx_plover` | 自动做梦参数（minHours/minSessions） |
| `tengu_harbor` | 频道通知运行时门控 |
| `tengu_hive_evidence` | 验证代理门控 |
| `tengu_ant_model_override` | 内部模型覆盖 |
| `tengu_max_version_config` | 版本限制 |
| `tengu_hawthorn_window` | 每消息 tool result 字符预算 |
| `tengu_tool_pear` | 工具相关配置 |
| `tengu_session_memory` | 会话记忆门控 |
| `tengu_sm_config` | 会话记忆配置 |
| `tengu_strap_foyer` | 设置同步下载门控 |
| `tengu_enable_settings_sync_push` | 设置同步上传门控 |
| `tengu_sessions_elevated_auth_enforcement` | 会话提升认证 |
| `tengu_cicada_nap_ms` | 后台刷新节流 |
| `tengu_miraculo_the_bard` | 并发会话门控 |
| `tengu_kairos` | KAIROS 模式运行时门控 |
| `tengu_bridge_repl_v2_cse_shim_enabled` | Bridge session ID 兼容层 |
| `tengu_amber_quartz_disabled` | 语音模式 killswitch |

**命名规则**：`tengu_` + 随机形容词/名词对（如 `cobalt_frost`、`onyx_plover`），这是一种常见的内部代号风格，避免 flag 名称暴露功能意图。

### 6.3 `product.ts` 中的 Tengu 引用

```typescript
// The cse_->session_ translation is a temporary shim gated by
// tengu_bridge_repl_v2_cse_shim_enabled
```

这证明 "tengu" 不仅是遥测前缀，也是整个项目基础设施的标识。

---

## 七、其他隐藏功能

### 7.1 Voice Mode（语音模式）

`voice/voiceModeEnabled.ts` 揭示：
- 需要 Anthropic OAuth 认证（使用 claude.ai 的 voice_stream 端点）
- `tengu_amber_quartz_disabled` 为 killswitch（默认不禁用，新安装即可用）
- 不支持 API Key、Bedrock、Vertex、Foundry

### 7.2 MoreRight

`moreright/useMoreRight.tsx` 是一个**外部构建的空桩**：

```typescript
// Stub for external builds -- the real hook is internal only.
export function useMoreRight(_args: {...}): {
  onBeforeQuery, onTurnComplete, render
} {
  return { onBeforeQuery: async () => true, onTurnComplete: async () => {}, render: () => null };
}
```

真实实现仅在内部构建可用，具体功能未知，但接口暗示它是一个查询前/后的拦截层。

### 7.3 NATIVE_CLIENT_ATTESTATION

`system.ts` 中的原生客户端认证：

```typescript
// cch=00000 placeholder is overwritten by Bun's native HTTP stack
// with a computed hash. The server verifies this token to confirm
// the request came from a real Claude Code client.
// See bun-anthropic/src/http/Attestation.zig
```

Zig 实现的原生 HTTP 层会在请求发送前将 `cch=00000` 替换为计算后的哈希值，用于服务端验证请求来自真实的 Claude Code 客户端（反仿冒）。使用固定长度占位符避免 Content-Length 变化和 buffer 重分配。

### 7.4 "Capybara" 模型代号

从 `prompts.ts` 和 `undercover.ts` 的多处注释可确认：
- `@[MODEL LAUNCH]: Update comment writing for Capybara` -- Capybara 是一个即将/已发布的模型
- Undercover prompt 明确列出 "animal names like Capybara, Tengu" 为需要隐藏的内部代号
- `buddy/types.ts` 中 capybara 物种名用 `fromCharCode` 编码，正是因为它与模型代号冲突

---

## 八、constants/ 目录 21 文件摘要

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `apiLimits.ts` | 95 | 图片 5MB base64、PDF 100 页、媒体 100/请求 |
| `betas.ts` | 53 | 20+ 个 Beta 头，含 `token-efficient-tools-2026-03-28` |
| `common.ts` | 34 | 日期工具、memoized 会话日期 |
| `cyberRiskInstruction.ts` | 24 | Safeguards 团队维护的安全边界指令 |
| `errorIds.ts` | 15 | 混淆错误 ID（当前 Next ID: 346） |
| `figures.ts` | 46 | Unicode 状态指示符、Bridge spinner |
| `files.ts` | 157 | 二进制扩展名集合、内容检测 |
| `github-app.ts` | 144 | GitHub Action 工作流模板 |
| `keys.ts` | 11 | 三级 GrowthBook SDK Key |
| `messages.ts` | 1 | `NO_CONTENT_MESSAGE` |
| `oauth.ts` | 235 | OAuth 全配置（prod/staging/local/FedStart） |
| `outputStyles.ts` | 216 | 内置输出风格：Default/Explanatory/Learning |
| `product.ts` | 77 | 产品 URL、远程会话、tengu shim |
| `prompts.ts` | 500+ | 系统提示核心，KAIROS/Proactive/Undercover 注入点 |
| `spinnerVerbs.ts` | 205 | 204 个加载动词（Clauding、Gitifying...） |
| `system.ts` | 96 | 系统前缀、归因头、客户端认证 |
| `systemPromptSections.ts` | 69 | 系统提示分段缓存框架 |
| `toolLimits.ts` | 57 | 工具结果 50K 字符/100K token 限制 |
| `tools.ts` | 113 | 代理工具白名单/黑名单 |
| `turnCompletionVerbs.ts` | 13 | 完成动词（Baked, Brewed...） |
| `xml.ts` | 87 | XML tag 常量（tick、task、channel、fork...） |

---

## 九、产品方向总结

从 Feature Flag 的全景来看，Claude Code 的演进方向清晰：

1. **从工具到助理** (KAIROS)：Sleep/Wake 循环、主动通知、频道监听，都指向 "always-on AI"
2. **从单体到群体** (Coordinator/Fork/Swarm)：多代理协作、UDS 跨进程通信、团队记忆同步
3. **从文本到多模态** (Voice/Browser/Image)：语音模式、内嵌浏览器、原生剪贴板图片
4. **从本地到远程** (Bridge/CCR/SSH)：远程开发环境、自动连接、镜像同步
5. **从无状态到有记忆** (Dream/SessionMemory/TeamMem)：自动做梦整合记忆、会话记忆持久化、团队知识同步
6. **从信任到验证** (Attestation/AntiDistillation/Verification)：客户端认证、反蒸馏、对抗性验证代理

Claude Code 不再只是一个编码助手，它正在成为一个**分布式、多代理、持久记忆、主动感知的 AI 开发伙伴平台**。
