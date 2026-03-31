# 04 - Deep Dive into the Command System

## Overview

Claude Code's command system (slash commands) is a modular, lazily-loaded, multi-source command framework. The core registration file is `commands.ts` (754 lines), which aggregates commands from **6 sources** and determines the user-visible command set through two layers of filtering (availability check + enabled state check).

**Key Facts**:
- Approximately 90+ built-in commands (including conditional commands controlled by feature flags)
- Command types: `local` (local execution), `local-jsx` (with Ink UI rendering), `prompt` (injects a prompt for the model to execute)
- All implementations use lazy loading (`load: () => import(...)`), minimizing startup time
- The command system serves both the interactive TUI and non-interactive SDK/CI scenarios

---

## 1. Command Type System

### 1.1 Type Definitions

Command types are defined in `src/types/command.ts`, using a **union type + common base class** pattern:

```typescript
export type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

Each of the three subtypes has a clear responsibility:

| Type | Execution Method | Return Value | Typical Use Cases |
|------|---------|--------|---------|
| `prompt` | Generates a prompt injected into the conversation for the model to execute | `ContentBlockParam[]` | /commit, /review, /init, /security-review |
| `local` | Executes synchronously in-process, returns text result | `LocalCommandResult` | /compact, /clear, /cost, /vim |
| `local-jsx` | Renders Ink/React UI components | `React.ReactNode` | /model, /config, /help, /login |

### 1.2 CommandBase Common Properties

`CommandBase` defines the common properties for all commands (`src/types/command.ts:175-203`):

- **`availability?: CommandAvailability[]`** -- Declares which authentication/provider the command is visible to (`'claude-ai'` | `'console'`)
- **`isEnabled?: () => boolean`** -- Dynamic enabled state (feature flags, environment variables, etc.)
- **`isHidden?: boolean`** -- Whether to hide from typeahead/help
- **`aliases?: string[]`** -- Command aliases (e.g., clear has aliases reset/new)
- **`argumentHint?: string`** -- Parameter hint (displayed in grey in the UI)
- **`whenToUse?: string`** -- Usage scenario description the model can reference (Skill specification)
- **`disableModelInvocation?: boolean`** -- Whether to prevent the model from invoking it automatically
- **`immediate?: boolean`** -- Whether to execute immediately without waiting for a stop point (bypasses the queue)
- **`isSensitive?: boolean`** -- Whether arguments need to be redacted from history
- **`loadedFrom?`** -- Source tag: `'commands_DEPRECATED'` | `'skills'` | `'plugin'` | `'managed'` | `'bundled'` | `'mcp'`
- **`kind?: 'workflow'`** -- Distinguishes workflow commands

### 1.3 Lazy Loading Implementation

All `local` and `local-jsx` commands use the **`load()` lazy loading** pattern:

```typescript
// local command
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>  // { call: LocalCommandCall }
}

// local-jsx command
type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>  // { call: LocalJSXCommandCall }
}
```

**The elegance of this design**: A command's `index.ts` only exports metadata (name, description, type), without importing the actual implementation. The real `.call()` method is deferred via `load: () => import('./xxx.js')` until the user actually invokes the command. This way, even with 90+ registered commands, only a few KB of metadata are loaded at startup.

For particularly large modules, there is an even more aggressive lazy loading approach:

```typescript
// insights.ts is 113KB (3200 lines), wrapped with a lazy shim
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

## 2. Command Registration Mechanism — Merging Strategy for 6 Sources

### 2.1 The Six Command Sources

The `loadAllCommands()` function (`commands.ts:449-469`) reveals the 6 command sources and their merge order:

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
    ...bundledSkills,          // 1. Built-in bundled Skills
    ...builtinPluginSkills,    // 2. Built-in plugin Skills
    ...skillDirCommands,       // 3. Skills from .claude/skills/ directory
    ...workflowCommands,       // 4. Workflow commands
    ...pluginCommands,         // 5. Third-party plugin commands
    ...pluginSkills,           // 6. Plugin Skills
    ...COMMANDS(),             // 7. Hard-coded built-in commands (last)
  ]
})
```

Note that the array merge order determines **priority**: `findCommand()` uses `Array.find()`, so earlier entries match first. Therefore:

| Priority | Source | Description |
|--------|------|------|
| 1 (Highest) | bundledSkills | Skills compiled into the binary (e.g., /commit as a bundled skill) |
| 2 | builtinPluginSkills | Skills provided by built-in enabled plugins |
| 3 | skillDirCommands | User's `.claude/skills/` or `~/.claude/skills/` directory |
| 4 | workflowCommands | Workflow commands under `feature('WORKFLOW_SCRIPTS')` |
| 5 | pluginCommands | Commands registered by third-party plugins |
| 6 | pluginSkills | Skills registered by third-party plugins |
| 7 (Lowest) | COMMANDS() | Hard-coded built-in command array |

### 2.2 Dynamic Skill Discovery

The `getCommands()` function (`commands.ts:476-517`) additionally merges **dynamically discovered Skills** (`getDynamicSkills()`) on top of the memoized result from `loadAllCommands()`. These Skills are discovered by the model during file operations and are inserted before the built-in commands after deduplication (via a `baseCommandNames` Set):

```typescript
// Insertion point: before built-in commands
const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))
```

### 2.3 Caching and Refresh

Command loading uses lodash `memoize`, cached by `cwd`. Two refresh methods are provided:

- **`clearCommandMemoizationCaches()`** -- Clears only the command list cache (used when dynamic Skills are added)
- **`clearCommandsCache()`** -- Clears all caches (including plugin and Skill directory caches)

---

## 3. Two-Layer Filtering Mechanism

### 3.1 First Layer: Availability Filtering

`meetsAvailabilityRequirement()` checks the command's `availability` field to determine whether the current user is eligible to see the command:

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true  // No declaration = available to everyone
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

**Key detail**: This function is **not memoized** because the authentication state can change during a session (e.g., after executing `/login`).

### 3.2 Second Layer: Enabled State Filtering (isEnabled)

```typescript
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true  // Enabled by default
}
```

Common patterns for enabling conditions:

| Condition Pattern | Example |
|---------|------|
| Feature Flag | `isEnabled: () => checkStatsigFeatureGate('tengu_thinkback')` |
| Environment Variable | `isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT)` |
| User Type | `isEnabled: () => process.env.USER_TYPE === 'ant'` |
| Auth State | `isEnabled: () => isOverageProvisioningAllowed()` |
| Platform Check | `isEnabled: () => isSupportedPlatform()` (macOS/Win) |
| Session Mode | `isEnabled: () => !getIsNonInteractiveSession()` |
| Combined Conditions | `isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession()` |

---

## 4. Complete Analysis of Internal Commands

### 4.1 Full INTERNAL_ONLY_COMMANDS List

The `INTERNAL_ONLY_COMMANDS` array (`commands.ts:225-254`) defines commands available only when `USER_TYPE === 'ant'` and `!IS_DEMO`:

| Command | Type | Description |
|------|------|------|
| `backfillSessions` | stub | Session data backfill |
| `breakCache` | stub | Force cache invalidation |
| `bughunter` | stub | Bug hunter tool |
| `commit` | prompt | Git commit (internal version; external users use the skill) |
| `commitPushPr` | prompt | Commit + push + create PR |
| `ctx_viz` | stub | Context visualization |
| `goodClaude` | stub | Good Claude feedback |
| `issue` | stub | Issue management |
| `initVerifiers` | prompt | Create verifier Skills |
| `forceSnip` | (conditional) | Force history snipping (requires HISTORY_SNIP flag) |
| `mockLimits` | stub | Mock rate limits |
| `bridgeKick` | local | Bridge debugging tool (injects fault state) |
| `version` | local | Print build version and timestamp |
| `ultraplan` | (conditional) | Ultra plan (requires ULTRAPLAN flag) |
| `subscribePr` | (conditional) | PR subscription (requires KAIROS_GITHUB_WEBHOOKS flag) |
| `resetLimits` | stub | Reset limits |
| `resetLimitsNonInteractive` | stub | Reset limits (non-interactive) |
| `onboarding` | stub | Onboarding flow |
| `share` | stub | Share session |
| `summary` | stub | Conversation summary |
| `teleport` | stub | Teleport |
| `antTrace` | stub | Ant trace |
| `perfIssue` | stub | Performance issue report |
| `env` | stub | View environment variables |
| `oauthRefresh` | stub | OAuth refresh |
| `debugToolCall` | stub | Debug tool calls |
| `agentsPlatform` | (conditional) | Agent platform (require only for ant users) |
| `autofixPr` | stub | Auto-fix PR |

**Note**: Many internal commands are compiled as stubs (`{ isEnabled: () => false, isHidden: true, name: 'stub' }`) in external builds, achieved through dead code elimination.

### 4.2 Feature Flag Conditional Loading

Beyond `INTERNAL_ONLY_COMMANDS`, many commands use the `feature()` macro for **compile-time conditional loading**:

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

These use `require()` instead of `import()` because they need to be loaded synchronously during module initialization (`feature()` is a compile-time constant, and Bun's bundler performs dead code elimination at build time).

---

## 5. Complete Command List

### 5.1 Built-in Public Commands (Visible to All Users)

| Command Name | Type | Aliases | Description | Conditions/Notes |
|-------|------|------|------|----------|
| add-dir | local-jsx | - | Add a new working directory | - |
| advisor | local | - | Configure advisor model | Only when canUserConfigureAdvisor() |
| agents | local-jsx | - | Manage agent configurations | - |
| branch | local-jsx | fork (when FORK_SUBAGENT is not enabled) | Create a conversation branch | - |
| btw | local-jsx | - | Quick side question (without interrupting main conversation) | immediate |
| chrome | local-jsx | - | Chrome browser setup | availability: claude-ai |
| clear | local | reset, new | Clear conversation history | - |
| color | local-jsx | - | Set session color bar | immediate |
| compact | local | - | Compact conversation while preserving summary | Unless DISABLE_COMPACT |
| config | local-jsx | settings | Open settings panel | - |
| context | local-jsx / local | - | Visualize context usage | Dual interactive/non-interactive versions |
| copy | local-jsx | - | Copy last reply to clipboard | - |
| cost | local | - | Display session cost and duration | Hidden for claude-ai subscribers |
| desktop | local-jsx | app | Continue session in Claude Desktop | availability: claude-ai, macOS/Win |
| diff | local-jsx | - | View uncommitted changes and per-turn diffs | - |
| doctor | local-jsx | - | Diagnose installation and setup | Unless DISABLE_DOCTOR |
| effort | local-jsx | - | Set model effort level | - |
| exit | local-jsx | quit | Exit REPL | immediate |
| export | local-jsx | - | Export conversation to file/clipboard | - |
| extra-usage | local-jsx / local | - | Configure extra usage | Requires overage permission |
| fast | local-jsx | - | Toggle fast mode | availability: claude-ai, console |
| feedback | local-jsx | bug | Submit feedback | Excludes 3P/Bedrock/Vertex |
| files | local | - | List all files in context | ant only |
| heapdump | local | - | Heap dump to desktop | isHidden |
| help | local-jsx | - | Show help | - |
| hooks | local-jsx | - | View Hook configuration | immediate |
| ide | local-jsx | - | Manage IDE integration | - |
| init | prompt | - | Initialize CLAUDE.md | - |
| insights | prompt | - | Generate usage report | Lazy-loaded 113KB |
| install-github-app | local-jsx | - | Set up GitHub Actions | availability: claude-ai, console |
| install-slack-app | local | - | Install Slack app | availability: claude-ai |
| keybindings | local | - | Open keybinding configuration | Requires keybinding feature enabled |
| login | local-jsx | - | Log in to Anthropic account | 1P only (not 3P services) |
| logout | local-jsx | - | Log out | 1P only |
| mcp | local-jsx | - | Manage MCP servers | immediate |
| memory | local-jsx | - | Edit Claude memory file | - |
| mobile | local-jsx | ios, android | Show phone download QR code | - |
| model | local-jsx | - | Set AI model | Dynamic description |
| output-style | local-jsx | - | (Deprecated) -> use /config | isHidden |
| passes | local-jsx | - | Share free Claude Code week | Conditionally displayed |
| permissions | local-jsx | allowed-tools | Manage tool permission rules | - |
| plan | local-jsx | - | Enable plan mode | - |
| plugin | local-jsx | plugins, marketplace | Manage plugins | immediate |
| pr-comments | prompt | - | Fetch PR comments | Migrated to plugin |
| privacy-settings | local-jsx | - | Privacy settings | Requires consumer subscriber |
| rate-limit-options | local-jsx | - | Rate limit options | isHidden, internal use |
| release-notes | local | - | View changelog | - |
| reload-plugins | local | - | Activate pending plugin changes | - |
| remote-control | local-jsx | rc | Remote control connection | Requires BRIDGE_MODE flag |
| remote-env | local-jsx | - | Configure remote environment | claude-ai + policy allowed |
| rename | local-jsx | - | Rename conversation | immediate |
| resume | local-jsx | continue | Resume a historical conversation | - |
| review | prompt | - | Code review a PR | - |
| ultrareview | local-jsx | - | Deep bug discovery (cloud) | Conditionally enabled |
| rewind | local | checkpoint | Revert code/conversation to a previous point in time | - |
| sandbox | local-jsx | - | Toggle sandbox mode | Dynamic description |
| security-review | prompt | - | Security review | Migrated to plugin |
| session | local-jsx | remote | Show remote session URL | Remote mode only |
| skills | local-jsx | - | List available Skills | - |
| stats | local-jsx | - | Usage statistics and activity | - |
| status | local-jsx | - | Show full status information | immediate |
| statusline | prompt | - | Set status line UI | - |
| stickers | local | - | Order stickers | - |
| tag | local-jsx | - | Toggle session tags | ant only |
| tasks | local-jsx | bashes | Background task management | - |
| terminal-setup | local-jsx | - | Install enter-key binding | Conditionally hidden |
| theme | local-jsx | - | Change theme | - |
| think-back | local-jsx | - | 2025 year-in-review | Feature gate |
| thinkback-play | local | - | Play review animation | isHidden, feature gate |
| upgrade | local-jsx | - | Upgrade to Max plan | availability: claude-ai |
| usage | local-jsx | - | Show plan usage limits | availability: claude-ai |
| vim | local | - | Toggle Vim edit mode | - |
| voice | local | - | Toggle voice mode | availability: claude-ai, feature gate |
| web-setup | local-jsx | - | Set up Web version of Claude Code | availability: claude-ai, requires CCR flag |

### 5.2 Feature Flag Conditional Commands

| Command | Feature Flag | Description |
|------|-------------|------|
| proactive | PROACTIVE / KAIROS | Proactive prompts |
| brief | KAIROS / KAIROS_BRIEF | Brief mode |
| assistant | KAIROS | AI assistant |
| remote-control | BRIDGE_MODE | Remote control terminal |
| remoteControlServer | DAEMON + BRIDGE_MODE | Remote control server |
| voice | VOICE_MODE | Voice mode |
| force-snip | HISTORY_SNIP | Force history snipping |
| workflows | WORKFLOW_SCRIPTS | Workflow scripts |
| web-setup | CCR_REMOTE_SETUP | Web remote setup |
| subscribe-pr | KAIROS_GITHUB_WEBHOOKS | PR event subscription |
| ultraplan | ULTRAPLAN | Ultra plan |
| torch | TORCH | Torch feature |
| peers | UDS_INBOX | Unix socket peer communication |
| fork | FORK_SUBAGENT | Fork subagent |
| buddy | BUDDY | Buddy mode |

---

## 6. Elegant Design of Prompt Commands

### 6.1 `!command` Syntax — Embedded Shell Execution within Prompts

This is one of the most ingenious designs in Claude Code's command system. Prompt command templates can embed Shell commands that are automatically executed and replaced with their output before being sent to the model.

The implementation is in `src/utils/promptShellExecution.ts`:

```typescript
// Code block syntax: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// Inline syntax: !`command`
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm
```

**Execution flow**:
1. Scan the prompt template text for `!`command`` and `` ```! ``` `` patterns
2. For each match, **check permissions first** (`hasPermissionsToUseTool`)
3. Call `BashTool.call()` or `PowerShellTool.call()` to execute
4. Replace stdout/stderr back into the original template position
5. The final substituted text becomes the model's input

**Security design**:
- Uses a **positive lookbehind assertion** (`(?<=^|\s)`) to prevent false matches with Shell variables like `$!`
- **Performance optimization** for INLINE_PATTERN: checks `text.includes('!`')` before executing the regex (93% of Skills don't use this syntax, avoiding unnecessary regex overhead)
- Replacement uses a **function replacer** (`result.replace(match[0], () => output)`) instead of string replacement to prevent special replacement patterns like `$$`, `$&` from corrupting Shell output
- Supports frontmatter specifying `shell: powershell`, but this is controlled by a runtime switch

### 6.2 Analysis of Typical Prompt Commands

#### /commit — Git Commit

File: `src/commands/commit.ts`

**Core prompt template**:
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

**Design highlights**:
- Collects git status, diff, branch, and history via `!`command`` before the prompt is sent
- `allowedTools` is strictly limited to `['Bash(git add:*)', 'Bash(git status:*)', 'Bash(git commit:*)']`
- Temporarily injects `alwaysAllowRules` when executing `!`command`` to avoid permission prompts
- Supports Undercover mode (removes attribution for internal ant users)

#### /init — Project Initialization

File: `src/commands/init.ts` (484-line prompt)

This is the **most complex prompt command** in Claude Code, containing 8 phases:

1. **Phase 1**: Ask the user what to set up (CLAUDE.md / skills / hooks)
2. **Phase 2**: Explore the codebase (launch a subagent to scan project files)
3. **Phase 3**: Fill information gaps (interactive via AskUserQuestion)
4. **Phase 4**: Write CLAUDE.md
5. **Phase 5**: Write CLAUDE.local.md (personal settings)
6. **Phase 6**: Suggest and create Skills
7. **Phase 7**: Suggest additional optimizations (GitHub CLI, lint, hooks)
8. **Phase 8**: Summary and next steps

**Two prompt variants**: Switched via `feature('NEW_INIT')`, the new version adds Skill/Hook creation, git worktree detection, and the AskUserQuestion interactive flow.

#### /security-review — Security Review

File: `src/commands/security-review.ts` (243 lines)

**Migrated to the plugin architecture**, wrapped via `createMovedToPluginCommand()`. Internal users see a "please install the plugin" prompt, while external users see the full security review prompt.

Prompt features:
- Uses **frontmatter** to declare `allowed-tools` (git diff/status/log/show, Read, Glob, Grep, LS, Task)
- Three-phase analysis methodology: Repository context research -> Comparative analysis -> Vulnerability assessment
- **Parallel subtasks**: First uses one subtask to discover vulnerabilities, then launches multiple subtasks in parallel to filter out false positives
- Confidence scores < 0.7 are discarded directly, reducing false positives

```
START ANALYSIS:
1. Use a sub-task to identify vulnerabilities...
2. Then for each vulnerability, create a new sub-task to filter out false-positives.
   Launch these sub-tasks as parallel sub-tasks.
3. Filter out any vulnerabilities where the sub-task reported a confidence less than 8.
```

#### /review — PR Review

File: `src/commands/review.ts`

A relatively concise prompt command that guides the model to use the `gh` CLI to fetch PR details and diffs, then perform a code review. Complements `/ultrareview` (remote bughunter).

#### /statusline — Status Line Setup

File: `src/commands/statusline.tsx`

One of the most concise prompt commands, but it demonstrates the **agent delegation pattern**:

```typescript
async getPromptForCommand(args): Promise<ContentBlockParam[]> {
  const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration'
  return [{
    type: 'text',
    text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`
  }]
}
```

It instructs the model to create a dedicated subagent (statusline-setup) to carry out the setup work.

---

## 7. Remote/Bridge Mode Security Allowlist

### 7.1 REMOTE_SAFE_COMMANDS

When using `--remote` mode, only the following commands are allowed (`commands.ts:619-637`):

| Command | Rationale |
|------|------|
| session | Display remote session QR code |
| exit | Exit TUI |
| clear | Clear screen |
| help | Show help |
| theme | Change theme |
| color | Change color |
| vim | Toggle Vim mode |
| cost | Show cost |
| usage | Usage information |
| copy | Copy message |
| btw | Quick question |
| feedback | Send feedback |
| plan | Plan mode |
| keybindings | Key bindings |
| statusline | Status line |
| stickers | Stickers |
| mobile | Phone QR code |

**Design principle**: These commands only affect local TUI state and do not depend on the local filesystem, Git, Shell, IDE, MCP, or any other local execution context.

### 7.2 BRIDGE_SAFE_COMMANDS

The allowlist for commands arriving through Remote Control bridge (phone/Web client) (`commands.ts:651-660`):

| Command | Rationale |
|------|------|
| compact | Reduce context — useful from mobile |
| clear | Clear records |
| cost | Show cost |
| summary | Conversation summary |
| release-notes | Changelog |
| files | List tracked files |

### 7.3 Layered Security of isBridgeSafeCommand

```typescript
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false    // All JSX commands are prohibited
  if (cmd.type === 'prompt') return true         // All prompt commands are allowed
  return BRIDGE_SAFE_COMMANDS.has(cmd)           // local commands require allowlisting
}
```
