# 04 - 命令系统深度分析

## 概述

Claude Code 的命令系统（斜杠命令）是一个模块化、懒加载、多来源的命令框架。核心注册文件为 `commands.ts`（754 行），它汇集了来自 **6 个来源** 的命令，并通过两层过滤（可用性检查 + 启用状态检查）来决定用户可见的命令集合。

**核心数据**：
- 内置命令约 90+ 个（含 feature flag 控制的条件命令）
- 命令类型：`local`（本地执行）、`local-jsx`（带 Ink UI 渲染）、`prompt`（注入提示词让模型执行）
- 所有实现均采用懒加载模式（`load: () => import(...)`），最大限度减少启动时间
- 命令系统同时服务于用户交互式 TUI 和非交互式 SDK/CI 场景

---

## 一、命令类型系统（Command Type System）

### 1.1 类型定义

命令类型在 `src/types/command.ts` 中定义，采用 **联合类型 + 公共基类** 模式：

```typescript
export type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

三种子类型各有明确职责：

| 类型 | 执行方式 | 返回值 | 典型场景 |
|------|---------|--------|---------|
| `prompt` | 生成提示词注入对话，让模型执行 | `ContentBlockParam[]` | /commit, /review, /init, /security-review |
| `local` | 在进程内同步执行，返回文本结果 | `LocalCommandResult` | /compact, /clear, /cost, /vim |
| `local-jsx` | 渲染 Ink/React UI 组件 | `React.ReactNode` | /model, /config, /help, /login |

### 1.2 CommandBase 公共属性

`CommandBase` 定义了所有命令的公共属性（`src/types/command.ts:175-203`）：

- **`availability?: CommandAvailability[]`** -- 声明命令对哪些认证/提供商可见（`'claude-ai'` | `'console'`）
- **`isEnabled?: () => boolean`** -- 动态启用状态（feature flag、环境变量等）
- **`isHidden?: boolean`** -- 是否在 typeahead/help 中隐藏
- **`aliases?: string[]`** -- 命令别名（如 clear 的别名 reset/new）
- **`argumentHint?: string`** -- 参数提示（在 UI 中灰色显示）
- **`whenToUse?: string`** -- 模型可参考的使用场景描述（Skill 规范）
- **`disableModelInvocation?: boolean`** -- 是否禁止模型自动调用
- **`immediate?: boolean`** -- 是否立即执行，不等待停止点（绕过队列）
- **`isSensitive?: boolean`** -- 参数是否需要从历史中脱敏
- **`loadedFrom?`** -- 来源标记：`'commands_DEPRECATED'` | `'skills'` | `'plugin'` | `'managed'` | `'bundled'` | `'mcp'`
- **`kind?: 'workflow'`** -- 区分工作流命令

### 1.3 懒加载实现

所有 `local` 和 `local-jsx` 命令均采用 **`load()` 懒加载** 模式：

```typescript
// local 命令
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>  // { call: LocalCommandCall }
}

// local-jsx 命令
type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>  // { call: LocalJSXCommandCall }
}
```

**设计精妙之处**：命令的 `index.ts` 只导出元数据（名称、描述、类型），不导入具体实现。实际的 `.call()` 方法通过 `load: () => import('./xxx.js')` 延迟到用户实际调用时才加载。这样，即使注册了 90+ 命令，启动时只加载几 KB 的元数据。

对于特别大的模块，还有更极端的懒加载写法：

```typescript
// insights.ts 有 113KB (3200行)，用 lazy shim 包装
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  // ...
  async getPromptForCommand(args, context) {
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
```

---

## 二、命令注册机制 — 6 个来源的合并策略

### 2.1 六大命令来源

`loadAllCommands()` 函数（`commands.ts:449-469`）揭示了命令的 6 个来源及其合并顺序：

```typescript
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,          // 1. 内置打包的 Skill
    ...builtinPluginSkills,    // 2. 内置插件的 Skill
    ...skillDirCommands,       // 3. .claude/skills/ 目录的 Skill
    ...workflowCommands,       // 4. 工作流命令
    ...pluginCommands,         // 5. 第三方插件命令
    ...pluginSkills,           // 6. 插件 Skill
    ...COMMANDS(),             // 7. 内置硬编码命令（最后）
  ]
})
```

注意数组合并顺序决定了**优先级**：在 `findCommand()` 中使用 `Array.find()`，先出现的优先匹配。因此：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 (最高) | bundledSkills | 编译进二进制的 Skill（如 /commit 作为 bundled skill） |
| 2 | builtinPluginSkills | 内置启用的插件提供的 Skill |
| 3 | skillDirCommands | 用户 `.claude/skills/` 或 `~/.claude/skills/` 目录 |
| 4 | workflowCommands | `feature('WORKFLOW_SCRIPTS')` 下的工作流命令 |
| 5 | pluginCommands | 第三方插件注册的命令 |
| 6 | pluginSkills | 第三方插件注册的 Skill |
| 7 (最低) | COMMANDS() | 硬编码的内置命令数组 |

### 2.2 动态技能发现

`getCommands()` 函数（`commands.ts:476-517`）在 `loadAllCommands()` 的 memoized 结果之上，还额外合并了**动态发现的 Skill**（`getDynamicSkills()`）。这些 Skill 是模型在文件操作过程中发现的，通过去重（`baseCommandNames` Set）后插入到内置命令之前：

```typescript
// 插入点：内置命令之前
const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))
```

### 2.3 缓存与刷新

命令加载使用 lodash `memoize`，按 `cwd` 缓存。提供两种刷新方式：

- **`clearCommandMemoizationCaches()`** -- 只清除命令列表缓存（动态 Skill 添加时用）
- **`clearCommandsCache()`** -- 清除所有缓存（包括插件、Skill 目录缓存）

---

## 三、两层过滤机制

### 3.1 第一层：可用性过滤（Availability）

`meetsAvailabilityRequirement()` 检查命令的 `availability` 字段，判断当前用户是否有资格看到该命令：

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true  // 无声明 = 对所有人可用
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        if (!isClaudeAISubscriber() && !isUsing3PServices() && isFirstPartyAnthropicBaseUrl())
          return true
        break
    }
  }
  return false
}
```

**关键细节**：此函数 **不做 memoize**，因为认证状态可在会话中改变（如执行 `/login` 后）。

### 3.2 第二层：启用状态过滤（isEnabled）

```typescript
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true  // 默认启用
}
```

启用条件的常见模式：

| 条件模式 | 示例 |
|---------|------|
| Feature Flag | `isEnabled: () => checkStatsigFeatureGate('tengu_thinkback')` |
| 环境变量 | `isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT)` |
| 用户类型 | `isEnabled: () => process.env.USER_TYPE === 'ant'` |
| 认证状态 | `isEnabled: () => isOverageProvisioningAllowed()` |
| 平台检查 | `isEnabled: () => isSupportedPlatform()` (macOS/Win) |
| 会话模式 | `isEnabled: () => !getIsNonInteractiveSession()` |
| 组合条件 | `isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession()` |

---

## 四、内部命令完整分析

### 4.1 INTERNAL_ONLY_COMMANDS 完整列表

`INTERNAL_ONLY_COMMANDS` 数组（`commands.ts:225-254`）定义了仅在 `USER_TYPE === 'ant'` 且 `!IS_DEMO` 时可用的命令：

| 命令 | 类型 | 说明 |
|------|------|------|
| `backfillSessions` | stub | 会话数据回填 |
| `breakCache` | stub | 缓存强制失效 |
| `bughunter` | stub | Bug 猎人工具 |
| `commit` | prompt | Git 提交（内部版，外部用户通过 skill） |
| `commitPushPr` | prompt | 提交+推送+创建PR |
| `ctx_viz` | stub | 上下文可视化 |
| `goodClaude` | stub | Good Claude 反馈 |
| `issue` | stub | Issue 管理 |
| `initVerifiers` | prompt | 创建验证器 Skill |
| `forceSnip` | (条件) | 强制历史裁剪（需 HISTORY_SNIP flag） |
| `mockLimits` | stub | 模拟速率限制 |
| `bridgeKick` | local | 桥接调试工具（注入故障状态） |
| `version` | local | 打印构建版本和时间 |
| `ultraplan` | (条件) | 超级计划（需 ULTRAPLAN flag） |
| `subscribePr` | (条件) | PR 订阅（需 KAIROS_GITHUB_WEBHOOKS flag） |
| `resetLimits` | stub | 重置限制 |
| `resetLimitsNonInteractive` | stub | 重置限制（非交互） |
| `onboarding` | stub | 引导流程 |
| `share` | stub | 分享会话 |
| `summary` | stub | 对话摘要 |
| `teleport` | stub | 远程传送 |
| `antTrace` | stub | Ant 追踪 |
| `perfIssue` | stub | 性能问题报告 |
| `env` | stub | 环境变量查看 |
| `oauthRefresh` | stub | OAuth 刷新 |
| `debugToolCall` | stub | 调试工具调用 |
| `agentsPlatform` | (条件) | 代理平台（仅 ant 用户 require） |
| `autofixPr` | stub | 自动修复 PR |

**注意**：许多内部命令在外部构建中被编译为 stub（`{ isEnabled: () => false, isHidden: true, name: 'stub' }`），通过 dead code elimination 实现。

### 4.2 Feature Flag 条件加载

除了 `INTERNAL_ONLY_COMMANDS`，还有大量命令通过 `feature()` 宏实现**编译时条件加载**：

```typescript
const proactive = feature('PROACTIVE') || feature('KAIROS')
  ? require('./commands/proactive.js').default : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default : null
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default : null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? require('./commands/workflows/index.js').default : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? require('./commands/remote-setup/index.js').default : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default : null
const torch = feature('TORCH')
  ? require('./commands/torch.js').default : null
const peersCmd = feature('UDS_INBOX')
  ? require('./commands/peers/index.js').default : null
const forkCmd = feature('FORK_SUBAGENT')
  ? require('./commands/fork/index.js').default : null
const buddy = feature('BUDDY')
  ? require('./commands/buddy/index.js').default : null
```

这些使用 `require()` 而非 `import()` 是因为需要在模块初始化时同步加载（`feature()` 是编译时常量，Bun 的 bundler 在构建时做 dead code elimination）。

---

## 五、完整命令清单

### 5.1 内置公共命令（所有用户可见）

| 命令名 | 类型 | 别名 | 描述 | 条件/备注 |
|-------|------|------|------|----------|
| add-dir | local-jsx | - | 添加新的工作目录 | - |
| advisor | local | - | 配置 advisor 模型 | 仅当 canUserConfigureAdvisor() |
| agents | local-jsx | - | 管理代理配置 | - |
| branch | local-jsx | fork (当 FORK_SUBAGENT 未启用) | 创建对话分支 | - |
| btw | local-jsx | - | 快速侧问题（不打断主对话） | immediate |
| chrome | local-jsx | - | Chrome 浏览器设置 | availability: claude-ai |
| clear | local | reset, new | 清除对话历史 | - |
| color | local-jsx | - | 设置会话颜色条 | immediate |
| compact | local | - | 压缩对话但保留摘要 | 除非 DISABLE_COMPACT |
| config | local-jsx | settings | 打开设置面板 | - |
| context | local-jsx / local | - | 可视化上下文用量 | 交互/非交互双版本 |
| copy | local-jsx | - | 复制最后回复到剪贴板 | - |
| cost | local | - | 显示会话费用和时长 | claude-ai 订阅者隐藏 |
| desktop | local-jsx | app | 在 Claude Desktop 继续会话 | availability: claude-ai, macOS/Win |
| diff | local-jsx | - | 查看未提交变更和每轮 diff | - |
| doctor | local-jsx | - | 诊断安装和设置 | 除非 DISABLE_DOCTOR |
| effort | local-jsx | - | 设置模型努力程度 | - |
| exit | local-jsx | quit | 退出 REPL | immediate |
| export | local-jsx | - | 导出对话到文件/剪贴板 | - |
| extra-usage | local-jsx / local | - | 配置超额使用 | 需 overage 权限 |
| fast | local-jsx | - | 切换快速模式 | availability: claude-ai, console |
| feedback | local-jsx | bug | 提交反馈 | 排除 3P/Bedrock/Vertex |
| files | local | - | 列出上下文中的所有文件 | 仅 ant |
| heapdump | local | - | 堆转储到桌面 | isHidden |
| help | local-jsx | - | 显示帮助 | - |
| hooks | local-jsx | - | 查看 Hook 配置 | immediate |
| ide | local-jsx | - | 管理 IDE 集成 | - |
| init | prompt | - | 初始化 CLAUDE.md | - |
| insights | prompt | - | 生成使用报告 | 懒加载 113KB |
| install-github-app | local-jsx | - | 设置 GitHub Actions | availability: claude-ai, console |
| install-slack-app | local | - | 安装 Slack 应用 | availability: claude-ai |
| keybindings | local | - | 打开键绑定配置 | 需 keybinding 功能启用 |
| login | local-jsx | - | 登录 Anthropic 账户 | 仅 1P（非 3P 服务） |
| logout | local-jsx | - | 登出 | 仅 1P |
| mcp | local-jsx | - | 管理 MCP 服务器 | immediate |
| memory | local-jsx | - | 编辑 Claude 记忆文件 | - |
| mobile | local-jsx | ios, android | 显示手机下载二维码 | - |
| model | local-jsx | - | 设置 AI 模型 | 动态描述 |
| output-style | local-jsx | - | （已弃用）→ 用 /config | isHidden |
| passes | local-jsx | - | 分享免费 Claude Code 周 | 条件显示 |
| permissions | local-jsx | allowed-tools | 管理工具权限规则 | - |
| plan | local-jsx | - | 启用计划模式 | - |
| plugin | local-jsx | plugins, marketplace | 管理插件 | immediate |
| pr-comments | prompt | - | 获取 PR 评论 | 已迁移到插件 |
| privacy-settings | local-jsx | - | 隐私设置 | 需 consumer 订阅者 |
| rate-limit-options | local-jsx | - | 速率限制选项 | isHidden, 内部使用 |
| release-notes | local | - | 查看更新日志 | - |
| reload-plugins | local | - | 激活待定插件变更 | - |
| remote-control | local-jsx | rc | 远程控制连接 | 需 BRIDGE_MODE flag |
| remote-env | local-jsx | - | 配置远程环境 | claude-ai + 策略允许 |
| rename | local-jsx | - | 重命名对话 | immediate |
| resume | local-jsx | continue | 恢复历史对话 | - |
| review | prompt | - | 代码审查 PR | - |
| ultrareview | local-jsx | - | 深度 Bug 发现（云端） | 条件启用 |
| rewind | local | checkpoint | 回退代码/对话到之前时间点 | - |
| sandbox | local-jsx | - | 切换沙箱模式 | 动态描述 |
| security-review | prompt | - | 安全审查 | 已迁移到插件 |
| session | local-jsx | remote | 显示远程会话 URL | 仅远程模式 |
| skills | local-jsx | - | 列出可用 Skill | - |
| stats | local-jsx | - | 使用统计和活动 | - |
| status | local-jsx | - | 显示完整状态信息 | immediate |
| statusline | prompt | - | 设置状态行 UI | - |
| stickers | local | - | 订购贴纸 | - |
| tag | local-jsx | - | 切换会话标签 | 仅 ant |
| tasks | local-jsx | bashes | 后台任务管理 | - |
| terminal-setup | local-jsx | - | 安装换行键绑定 | 条件隐藏 |
| theme | local-jsx | - | 更改主题 | - |
| think-back | local-jsx | - | 2025 年度回顾 | feature gate |
| thinkback-play | local | - | 播放回顾动画 | isHidden, feature gate |
| upgrade | local-jsx | - | 升级到 Max 计划 | availability: claude-ai |
| usage | local-jsx | - | 显示计划用量限制 | availability: claude-ai |
| vim | local | - | 切换 Vim 编辑模式 | - |
| voice | local | - | 切换语音模式 | availability: claude-ai, feature gate |
| web-setup | local-jsx | - | 设置 Web 版 Claude Code | availability: claude-ai, 需 CCR flag |

### 5.2 Feature Flag 条件命令

| 命令 | Feature Flag | 说明 |
|------|-------------|------|
| proactive | PROACTIVE / KAIROS | 主动提示 |
| brief | KAIROS / KAIROS_BRIEF | 简报模式 |
| assistant | KAIROS | AI 助手 |
| remote-control | BRIDGE_MODE | 远程控制终端 |
| remoteControlServer | DAEMON + BRIDGE_MODE | 远程控制服务器 |
| voice | VOICE_MODE | 语音模式 |
| force-snip | HISTORY_SNIP | 强制历史裁剪 |
| workflows | WORKFLOW_SCRIPTS | 工作流脚本 |
| web-setup | CCR_REMOTE_SETUP | Web 远程设置 |
| subscribe-pr | KAIROS_GITHUB_WEBHOOKS | PR 事件订阅 |
| ultraplan | ULTRAPLAN | 超级计划 |
| torch | TORCH | Torch 功能 |
| peers | UDS_INBOX | Unix socket 对等通信 |
| fork | FORK_SUBAGENT | Fork 子代理 |
| buddy | BUDDY | 伙伴模式 |

---

## 六、Prompt 命令的精妙设计

### 6.1 `!command` 语法 — 提示词内嵌 Shell 执行

这是 Claude Code 命令系统中最精巧的设计之一。Prompt 命令的模板中可以嵌入 Shell 命令，在发送给模型之前自动执行并替换为输出结果。

实现位于 `src/utils/promptShellExecution.ts`：

```typescript
// 代码块语法: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// 内联语法: !`command`
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm
```

**执行流程**：
1. 扫描 prompt 模板文本中的 `!`command`` 和 `` ```! ``` `` 模式
2. 对每个匹配的命令，**先检查权限**（`hasPermissionsToUseTool`）
3. 调用 `BashTool.call()` 或 `PowerShellTool.call()` 执行
4. 将 stdout/stderr 替换回原始模板位置
5. 最终替换后的文本作为模型的输入

**安全设计**：
- 使用 **正向后行断言** (`(?<=^|\s)`) 防止误匹配 `$!` 等 Shell 变量
- 对 INLINE_PATTERN 做了**性能优化**：先检查 `text.includes('!`')` 再执行正则（93% 的 Skill 无此语法，避免不必要的正则开销）
- 替换使用 **函数替换器**（`result.replace(match[0], () => output)`）而非字符串替换，防止 `$$`, `$&` 等特殊替换模式破坏 Shell 输出
- 支持 frontmatter 指定 `shell: powershell`，但受运行时开关控制

### 6.2 典型 Prompt 命令分析

#### /commit — Git 提交

文件：`src/commands/commit.ts`

**Prompt 模板核心**：
```
## Context
- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Git Safety Protocol
- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc)
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend
- Do not commit files that likely contain secrets (.env, credentials.json, etc)
...

## Your task
Based on the above changes, create a single git commit:
1. Analyze all staged changes and draft a commit message...
2. Stage relevant files and create the commit using HEREDOC syntax...
```

**设计亮点**：
- 通过 `!`command`` 在 prompt 发送前就收集了 git 状态、diff、分支、历史
- `allowedTools` 严格限制为 `['Bash(git add:*)', 'Bash(git status:*)', 'Bash(git commit:*)']`
- 在执行 `!`command`` 时，临时注入 `alwaysAllowRules` 避免权限弹窗
- 支持 Undercover 模式（内部 ant 用户去除署名）

#### /init — 项目初始化

文件：`src/commands/init.ts`（484 行长 prompt）

这是 Claude Code 中**最复杂的 prompt 命令**，包含 8 个阶段：

1. **Phase 1**: 询问用户要设置什么（CLAUDE.md / skills / hooks）
2. **Phase 2**: 探索代码库（启动子代理扫描项目文件）
3. **Phase 3**: 填补信息空白（通过 AskUserQuestion 交互）
4. **Phase 4**: 写入 CLAUDE.md
5. **Phase 5**: 写入 CLAUDE.local.md（个人设置）
6. **Phase 6**: 建议并创建 Skill
7. **Phase 7**: 建议额外优化（GitHub CLI、lint、hooks）
8. **Phase 8**: 总结和后续步骤

**两套 prompt**：通过 `feature('NEW_INIT')` 切换新旧版本，新版增加了 Skill/Hook 创建、git worktree 检测、AskUserQuestion 交互式流程。

#### /security-review — 安全审查

文件：`src/commands/security-review.ts`（243 行）

**已迁移到插件架构**，通过 `createMovedToPluginCommand()` 封装。内部用户看到"请安装插件"的提示，外部用户看到完整的安全审查 prompt。

Prompt 特色：
- 使用 **frontmatter** 声明 `allowed-tools`（git diff/status/log/show, Read, Glob, Grep, LS, Task）
- 三阶段分析方法论：仓库上下文研究 -> 比较分析 -> 漏洞评估
- **子任务并行**：先用一个子任务发现漏洞，再并行启动多个子任务逐一过滤误报
- 信心评分 < 0.7 直接丢弃，减少假阳性

```
START ANALYSIS:
1. Use a sub-task to identify vulnerabilities...
2. Then for each vulnerability, create a new sub-task to filter out false-positives.
   Launch these sub-tasks as parallel sub-tasks.
3. Filter out any vulnerabilities where the sub-task reported a confidence less than 8.
```

#### /review — PR 审查

文件：`src/commands/review.ts`

相对简洁的 prompt 命令，指引模型使用 `gh` CLI 获取 PR 详情和 diff，然后进行代码审查。与 `/ultrareview`（remote bughunter）形成互补。

#### /statusline — 状态行设置

文件：`src/commands/statusline.tsx`

最简洁的 prompt 命令之一，但展示了**代理委派模式**：

```typescript
async getPromptForCommand(args): Promise<ContentBlockParam[]> {
  const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration'
  return [{
    type: 'text',
    text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`
  }]
}
```

它让模型创建一个专门的子代理（statusline-setup）来完成设置工作。

---

## 七、远程/桥接模式安全白名单

### 7.1 REMOTE_SAFE_COMMANDS

当使用 `--remote` 模式时，只允许以下命令（`commands.ts:619-637`）：

| 命令 | 理由 |
|------|------|
| session | 显示远程会话 QR 码 |
| exit | 退出 TUI |
| clear | 清屏 |
| help | 显示帮助 |
| theme | 更改主题 |
| color | 更改颜色 |
| vim | 切换 Vim 模式 |
| cost | 显示费用 |
| usage | 使用信息 |
| copy | 复制消息 |
| btw | 快速提问 |
| feedback | 发送反馈 |
| plan | 计划模式 |
| keybindings | 键绑定 |
| statusline | 状态行 |
| stickers | 贴纸 |
| mobile | 手机二维码 |

**设计原则**：这些命令只影响本地 TUI 状态，不依赖本地文件系统、Git、Shell、IDE、MCP 或其他本地执行上下文。

### 7.2 BRIDGE_SAFE_COMMANDS

当命令通过 Remote Control 桥接（手机/Web 客户端）到达时的白名单（`commands.ts:651-660`）：

| 命令 | 理由 |
|------|------|
| compact | 缩减上下文 — 手机端有用 |
| clear | 清除记录 |
| cost | 显示费用 |
| summary | 对话摘要 |
| release-notes | 更新日志 |
| files | 列出跟踪文件 |

### 7.3 isBridgeSafeCommand 的分层安全

```typescript
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false    // JSX 命令全部禁止
  if (cmd.type === 'prompt') return true         // prompt 命令全部允许
  return BRIDGE_SAFE_COMMANDS.has(cmd)           // local 命令需白名单
}
```

**三层安全策略**：
1. **`local-jsx` 全禁** -- 因为它们渲染 Ink UI，而桥接客户端无法渲染终端 UI
2. **`prompt` 全允** -- 因为它们只展开为文本发送给模型，天然安全
3. **`local` 白名单** -- 默认禁止，只有明确列出的才允许

这个设计源于 PR #19134：当时 iOS 客户端发送 `/model` 命令会在本地弹出 Ink picker UI，导致终端混乱。

---

## 八、local-jsx 在桥接中被禁止的原因

`local-jsx` 命令的核心特征是返回 `React.ReactNode`，由 Ink（React 终端渲染框架）渲染到 TUI 中。具体原因：

1. **渲染依赖终端**：Ink 组件直接操作终端（ANSI 转义序列、光标位置、键盘输入），桥接客户端（手机/Web）没有兼容的终端环境
2. **交互式 UI**：许多 `local-jsx` 命令呈现交互式选择器（如 `/model` 的模型选择列表、`/config` 的设置面板），需要键盘导航，远程客户端无法传递这些交互
3. **状态管理冲突**：`local-jsx` 命令通过 `onDone` 回调修改本地会话状态（`setMessages`、`onChangeAPIKey` 等），远程执行可能导致状态不一致
4. **Context 差异**：`LocalJSXCommandContext` 包含 `canUseTool`、`setMessages`、IDE 状态等本地上下文，桥接环境无法提供

对比之下，`prompt` 命令只生成文本（`ContentBlockParam[]`），天然兼容任何传输通道。`local` 命令返回纯文本结果，白名单内的也可以安全传输。

---

## 九、Skill 与 Command 的边界

### 9.1 SkillTool 的命令过滤

`getSkillToolCommands()`（`commands.ts:563-581`）决定哪些命令可以被模型作为 Skill 调用：

```typescript
cmd.type === 'prompt' &&           // 必须是 prompt 类型
!cmd.disableModelInvocation &&     // 未禁止模型调用
cmd.source !== 'builtin' &&       // 非内置命令
(cmd.loadedFrom === 'bundled' ||  // 来自打包 Skill
 cmd.loadedFrom === 'skills' ||   // 来自 skills 目录
 cmd.loadedFrom === 'commands_DEPRECATED' ||  // 来自旧 commands 目录
 cmd.hasUserSpecifiedDescription ||  // 有用户指定描述
 cmd.whenToUse)                     // 有使用场景说明
```

### 9.2 MCP Skill 的独立通道

MCP 提供的 Skill 通过 `getMcpSkillCommands()` 单独过滤（`commands.ts:547-559`），不走 `getCommands()` 主流程，由调用方自行合并。

---

## 十、formatDescriptionWithSource — 来源标注

用户在 typeahead 和 help 中看到的描述会带上来源标注（`commands.ts:728-754`）：

- **workflow**: `"描述 (workflow)"`
- **plugin**: `"(插件名) 描述"` 或 `"描述 (plugin)"`
- **builtin/mcp**: 原始描述
- **bundled**: `"描述 (bundled)"`
- **其他来源**: `"描述 (User/Project/Enterprise)"` -- 通过 `getSettingSourceName()` 映射

---

## 总结

Claude Code 的命令系统是一个精心设计的分层架构：

1. **类型安全**：三种命令类型（prompt/local/local-jsx）各有明确契约，通过 TypeScript 联合类型强制执行
2. **极致懒加载**：命令元数据和实现分离，113KB 的 insights 模块只在调用时才加载
3. **多来源合并**：6 个来源按优先级有序合并，支持用户自定义覆盖内置行为
4. **双层过滤**：可用性（auth）和启用状态（feature flag）分离关注点
5. **安全边界清晰**：远程模式和桥接模式有明确的白名单，local-jsx 按类型一刀切禁止
6. **Prompt 即代码**：`!`command`` 语法让 prompt 模板能在发送前动态收集上下文，是命令系统中最创新的设计
7. **渐进式迁移**：`createMovedToPluginCommand()` 支持命令从内置平滑迁移到插件生态
