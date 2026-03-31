# 10 - Feature Flags and Hidden Features (Deep Dive)

## Overview

Claude Code employs a sophisticated **three-layer Feature Flag architecture**: build-time `feature('FLAG')` (Bun bundler dead-code elimination), runtime GrowthBook Remote Eval (tengu\_\* namespace), and environment variables (`USER_TYPE`/`CLAUDE_CODE_*`). After exhaustively reading all 21 files in `constants/`, all 6 files in `buddy/`, `voice/`, `moreright/`, the GrowthBook integration, and the undercover system, the following is a complete analysis.

---

## I. Complete Categorized List of 88 Build-Time Feature Flags

Exhaustively extracted via `feature('...')` regex search (88 unique flags after deduplication):

### 1.1 KAIROS Assistant Mode Family (7 flags)

| Flag | Inferred Purpose | Code Evidence |
|------|---------|---------|
| `KAIROS` | Assistant/background agent master switch | Enables assistantModule, BriefTool, SleepTool, proactive system in `main.tsx` |
| `KAIROS_BRIEF` | Independent release of Brief concise output | OR-gate with KAIROS: `feature('KAIROS') \|\| feature('KAIROS_BRIEF')` |
| `KAIROS_CHANNELS` | MCP channel notifications/message reception | `channelNotification.ts`: receives external channel messages |
| `KAIROS_DREAM` | Memory consolidation "dreaming" system | `skills/bundled/index.ts`: registers /dream skill |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub PR subscription | `commands.ts`: registers subscribePr command |
| `KAIROS_PUSH_NOTIFICATION` | Push notifications | `tools.ts`: registers PushNotificationTool |
| `PROACTIVE` | Proactive intervention (coexists with KAIROS) | Always appears as `feature('PROACTIVE') \|\| feature('KAIROS')` |

### 1.2 Remote/Bridge/CCR Mode (5 flags)

| Flag | Inferred Purpose | Code Evidence |
|------|---------|---------|
| `BRIDGE_MODE` | CCR remote bridge master switch | `bridgeEnabled.ts`: 6 independent references, controls all bridge paths |
| `CCR_AUTO_CONNECT` | Remote auto-connect | `bridgeEnabled.ts:186` |
| `CCR_MIRROR` | Remote mirror sync | `remoteBridgeCore.ts`: outboundOnly branch |
| `CCR_REMOTE_SETUP` | Remote environment configuration | Remote session initialization flow |
| `SSH_REMOTE` | SSH remote connection | Remote development environment support |

### 1.3 Agent/Multi-Agent System (8 flags)

| Flag | Inferred Purpose | Code Evidence |
|------|---------|---------|
| `COORDINATOR_MODE` | Coordinator mode (pure dispatch) | `REPL.tsx:119`: getCoordinatorUserContext |
| `FORK_SUBAGENT` | Background forked sub-agent | `forkSubagent.ts`: runs independently in background |
| `VERIFICATION_AGENT` | Adversarial verification agent | `prompts.ts`: spawn verifier before completion |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in explore/plan agents | Dedicated sub-agents for search and planning |
| `AGENT_TRIGGERS` | Agent triggers/scheduled tasks | `tools.ts`: Cron tool registration |
| `AGENT_TRIGGERS_REMOTE` | Remote agent triggers | Scheduled tasks for remote environments |
| `AGENT_MEMORY_SNAPSHOT` | Agent memory snapshot | Sub-agent context passing |
| `WORKFLOW_SCRIPTS` | Workflow script execution | `tools.ts`: WorkflowTool registration |

### 1.4 Tools/Feature Enhancements (17 flags)

| Flag | Inferred Purpose |
|------|---------|
| `VOICE_MODE` | Voice mode (real-time STT/TTS) |
| `WEB_BROWSER_TOOL` | Built-in browser tool |
| `MONITOR_TOOL` | Process monitoring tool |
| `TERMINAL_PANEL` | Terminal panel UI |
| `MCP_RICH_OUTPUT` | MCP rich text output |
| `MCP_SKILLS` | MCP skill registration |
| `QUICK_SEARCH` | Quick search |
| `OVERFLOW_TEST_TOOL` | Overflow test tool |
| `REVIEW_ARTIFACT` | Code review artifact |
| `TEMPLATES` | Project template system |
| `TREE_SITTER_BASH` | Tree-sitter Bash parsing |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter shadow mode (comparison experiment) |
| `BASH_CLASSIFIER` | Bash command classifier |
| `POWERSHELL_AUTO_MODE` | PowerShell auto mode |
| `NOTEBOOK_EDIT_TOOL` | (Implied) Jupyter editing |
| `EXPERIMENTAL_SKILL_SEARCH` | Skill search experiment |
| `SKILL_IMPROVEMENT` | Skill self-improvement |

### 1.5 Context/Compaction/Memory (8 flags)

| Flag | Inferred Purpose |
|------|---------|
| `CACHED_MICROCOMPACT` | Cached micro-compaction configuration |
| `REACTIVE_COMPACT` | Reactive compaction |
| `COMPACTION_REMINDERS` | Compaction reminders |
| `CONTEXT_COLLAPSE` | Context collapse |
| `EXTRACT_MEMORIES` | Automatic memory extraction |
| `HISTORY_PICKER` | History session picker |
| `HISTORY_SNIP` | History snippet extraction |
| `AWAY_SUMMARY` | Away summary (catch-up report upon return) |

### 1.6 Output/UI (7 flags)

| Flag | Inferred Purpose |
|------|---------|
| `BUDDY` | Digital pet companion system |
| `MESSAGE_ACTIONS` | Message action menu |
| `BG_SESSIONS` | Background sessions |
| `STREAMLINED_OUTPUT` | Streamlined output |
| `ULTRAPLAN` | Ultra planning mode (remote parallel) |
| `ULTRATHINK` | Ultra thinking mode |
| `AUTO_THEME` | Auto theme switching |

### 1.7 Security/Telemetry/Infrastructure (17 flags)

| Flag | Inferred Purpose |
|------|---------|
| `NATIVE_CLIENT_ATTESTATION` | Native client attestation (Zig-implemented hash) |
| `ANTI_DISTILLATION_CC` | Anti-distillation protection |
| `TRANSCRIPT_CLASSIFIER` | Transcript classifier (AFK mode) |
| `CONNECTOR_TEXT` | Connector text summary |
| `COMMIT_ATTRIBUTION` | Commit attribution |
| `TOKEN_BUDGET` | Token budget control |
| `SHOT_STATS` | Per-shot statistics |
| `ABLATION_BASELINE` | Ablation baseline experiment |
| `PERFETTO_TRACING` | Perfetto performance tracing |
| `SLOW_OPERATION_LOGGING` | Slow operation logging |
| `ENHANCED_TELEMETRY_BETA` | Enhanced telemetry beta |
| `COWORKER_TYPE_TELEMETRY` | Co-worker type telemetry |
| `MEMORY_SHAPE_TELEMETRY` | Memory shape telemetry |
| `PROMPT_CACHE_BREAK_DETECTION` | Cache break detection |
| `HARD_FAIL` | Hard fail mode |
| `UNATTENDED_RETRY` | Unattended retry |
| `BREAK_CACHE_COMMAND` | Cache clear command |

### 1.8 Internal/Platform (11 flags)

| Flag | Inferred Purpose |
|------|---------|
| `ALLOW_TEST_VERSIONS` | Allow test versions |
| `BUILDING_CLAUDE_APPS` | Claude app building mode |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC environment runner |
| `CHICAGO_MCP` | Chicago MCP deployment |
| `DAEMON` | Daemon mode |
| `DIRECT_CONNECT` | Direct connect mode |
| `DOWNLOAD_USER_SETTINGS` | Download user settings |
| `UPLOAD_USER_SETTINGS` | Upload user settings |
| `DUMP_SYSTEM_PROMPT` | Dump system prompt |
| `FILE_PERSISTENCE` | File persistence |
| `HOOK_PROMPTS` | Hook prompt injection |

### 1.9 Other Specialized (8 flags)

| Flag | Inferred Purpose |
|------|---------|
| `LODESTONE` | Lodestone project (unknown) |
| `TORCH` | Torch project (unknown) |
| `TEAMMEM` | Team memory sync |
| `UDS_INBOX` | Unix Domain Socket inbox |
| `SELF_HOSTED_RUNNER` | Self-hosted runner |
| `RUN_SKILL_GENERATOR` | Skill generator |
| `NEW_INIT` | New initialization flow |
| `IS_LIBC_GLIBC` / `IS_LIBC_MUSL` | C library detection (Linux compatibility) |
| `NATIVE_CLIPBOARD_IMAGE` | Native clipboard image |

---

## II. KAIROS Assistant Mode Deep Dive

### 2.1 Sub-Flag Collaboration Diagram

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

Typical OR-gate pattern in code:

```typescript
// 1. Brief independently released but KAIROS includes it
feature('KAIROS') || feature('KAIROS_BRIEF')

// 2. Channel messages independently released
feature('KAIROS') || feature('KAIROS_CHANNELS')

// 3. Proactive coexists with KAIROS
feature('PROACTIVE') || feature('KAIROS')
```

**Core Logic**: KAIROS is a "superset" -- enabling it is equivalent to enabling all sub-features including Brief, Channels, Proactive, etc. However, each sub-feature can also be independently toggled for A/B testing.

### 2.2 SleepTool Implementation

Located at `tools/SleepTool/prompt.ts`:

```typescript
export const SLEEP_TOOL_PROMPT = `Wait for a specified duration. The user can interrupt the sleep at any time.
Use this when the user tells you to sleep or rest, when you have nothing to do,
or when you're waiting for something.
You may receive <tick> prompts -- these are periodic check-ins.
Look for useful work to do before sleeping.`
```

Key design points:
- Does not occupy a shell process (superior to `Bash(sleep ...)`)
- Can be called concurrently without blocking other tools
- Checks for pending work upon receiving `<tick>` heartbeats
- Each wake-up consumes one API call, but prompt cache expires after 5 minutes

### 2.3 "Dreaming" (KAIROS_DREAM) System Internals

**Entry point**: `services/autoDream/autoDream.ts` + `consolidationPrompt.ts`

**Triple-gated trigger (cheapest checks first)**:

1. **Time gate**: `lastConsolidatedAt` is >= minHours ago (default 24 hours)
2. **Session gate**: Number of transcripts since last consolidation >= minSessions (default 5)
3. **Lock gate**: No other process is currently consolidating (file lock `.consolidate-lock`, PID + mtime)

**Consolidation flow (4-phase prompt)**:

```
Phase 1 -- Orient: ls memory directory, read index, understand existing memory structure
Phase 2 -- Gather: Search recent transcript JSONL files (grep only narrow terms)
Phase 3 -- Consolidate: Merge new signals into existing topic files, correct outdated facts
Phase 4 -- Prune: Update index, keep <25KB, one entry per line <150 characters
```

**Technical implementation**:
- Executes via a forked independent sub-agent through `runForkedAgent()`
- `DreamTask` displays a progress bar at the bottom of the UI
- `tengu_onyx_plover` GrowthBook flag controls parameters
- Elegant lock mechanism: mtime serves as lastConsolidatedAt, PID prevents re-entry, HOLDER_STALE_MS=1h prevents stale locks

### 2.4 Product Direction Inference

KAIROS suggests Claude Code is evolving from a "tool" to an "assistant":
- **Sleep + Tick**: AI can reside in the background long-term, waking periodically to check
- **Brief/Chat mode**: Shifting from full-text output to concise messages
- **Channels**: Receiving external messages (Slack, Telegram, etc.)
- **Push Notification**: Proactively notifying users
- **Dream**: Like the human brain, consolidating memories during "sleep"
- **GitHub Webhooks**: Subscribing to PR events, tracking projects long-term

This is the vision of an **"Always-on AI pair programmer"**: not used and discarded, but continuously running in the background, proactively sensing environmental changes, and intervening at the right moment.

---

## III. Complete Anatomy of the Buddy Digital Pet

### 3.1 Full List of 18 Species

All species names are defined via `String.fromCharCode()` encoding in `buddy/types.ts`:

| # | Species | Hex Values | ASCII Art Characteristics |
|---|------|---------|---------------|
| 1 | duck | 0x64,0x75,0x63,0x6b | `<(. )___` duck |
| 2 | goose | 0x67,0x6f,0x6f,0x73,0x65 | `(.>` neck-stretching goose |
| 3 | blob | 0x62,0x6c,0x6f,0x62 | `.----.` jelly blob |
| 4 | cat | 0x63,0x61,0x74 | `/\_/\  (  w  )` cat |
| 5 | dragon | 0x64,0x72,0x61,0x67,0x6f,0x6e | `/^\  /^\` double-horned dragon |
| 6 | octopus | 0x6f,0x63,0x74,0x6f,0x70,0x75,0x73 | `/\/\/\/\` tentacled octopus |
| 7 | owl | 0x6f,0x77,0x6c | `(.)(.))` big-eyed owl |
| 8 | penguin | 0x70,0x65,0x6e,0x67,0x75,0x69,0x6e | `(.>.)` penguin |
| 9 | turtle | 0x74,0x75,0x72,0x74,0x6c,0x65 | `[______]` turtle shell |
| 10 | snail | 0x73,0x6e,0x61,0x69,0x6c | `.--.  ( @ )` snail |
| 11 | ghost | 0x67,0x68,0x6f,0x73,0x74 | `~\`~\`\`~\`~` ghost |
| 12 | axolotl | 0x61,0x78,0x6f,0x6c,0x6f,0x74,0x6c | `}~(. .. .)~{` axolotl |
| 13 | capybara | 0x63,0x61,0x70,0x79,0x62,0x61,0x72,0x61 | `n______n  (   oo   )` capybara |
| 14 | cactus | 0x63,0x61,0x63,0x74,0x75,0x73 | `n  ____  n` cactus |
| 15 | robot | 0x72,0x6f,0x62,0x6f,0x74 | `.[||].  [ ==== ]` robot |
| 16 | rabbit | 0x72,0x61,0x62,0x62,0x69,0x74 | `(\__/)  =(  ..  )=` rabbit |
| 17 | mushroom | 0x6d,0x75,0x73,0x68,0x72,0x6f,0x6f,0x6d | `.-o-OO-o-.` mushroom |
| 18 | chonk | 0x63,0x68,0x6f,0x6e,0x6b | `/\    /\  (   ..   )` chonky cat |

### 3.2 Why `String.fromCharCode` Encoding Is Used

The source comment says it all:

```typescript
// One species name collides with a model-codename canary in excluded-strings.txt.
// The check greps build output (not source), so runtime-constructing the value keeps
// the literal out of the bundle while the check stays armed for the actual codename.
// All species encoded uniformly; `as` casts are type-position only (erased pre-bundle).
```

**The real reason**: Anthropic maintains an `excluded-strings.txt` file, and the build system greps build artifacts to check for leaked internal model codenames. One species name (most likely **capybara** -- an internal Anthropic model codename) conflicts with this blocklist. To avoid triggering canary detection, all species are uniformly encoded with `fromCharCode`. This also confirms that "Capybara" is indeed an internal Anthropic model codename (the code comment `@[MODEL LAUNCH]: Update comment writing for Capybara` appears multiple times).

### 3.3 Rarity Weight System

```typescript
export const RARITY_WEIGHTS = {
  common:    60,  // 60%
  uncommon:  25,  // 25%
  rare:      10,  // 10%
  epic:       4,  //  4%
  legendary:  1,  //  1%
}
```

Rarity effects:
- **Base stats**: common 5 / uncommon 15 / rare 25 / epic 35 / legendary 50
- **Hats**: common has no hat, other rarities get randomly assigned hats
- **Shiny**: Any rarity has a 1% chance of being shiny

### 3.4 Stat System

5 stats: `DEBUGGING`, `PATIENCE`, `CHAOS`, `WISDOM`, `SNARK`

Generation rules:
- Randomly select one peak stat (+50 base + 0-30 random)
- Randomly select one dump stat (base floor -10 + 0-15 random)
- Remaining stats = base floor + 0-40 random

### 3.5 Hat System

8 hat types (common gets none): `none`, `crown`, `tophat`, `propeller`, `halo`, `wizard`, `beanie`, `tinyduck`

Corresponding ASCII art lines:
```
crown:     \^^^/
tophat:    [___]
propeller:  -+-
halo:      (   )
wizard:     /^\
beanie:    (___)
tinyduck:   ,>
```

### 3.6 April 1st Launch Strategy

```typescript
// Teaser window: April 1-7, 2026 only. Command stays live forever after.
export function isBuddyTeaserWindow(): boolean {
  if ("external" === 'ant') return true;  // Always visible for internal users
  const d = new Date();
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7;
}
export function isBuddyLive(): boolean {
  return d.getFullYear() > 2026 || (d.getFullYear() === 2026 && d.getMonth() >= 3);
}
```

Strategy:
- **April 1-7, 2026**: Teaser window, users who haven't hatched see a rainbow-colored `/buddy` notification (disappears after 15 seconds)
- **Permanently active after April 1st**: `isBuddyLive()` returns true
- **Uses local time**, not UTC -- the comment explains: rolling 24-hour wave across time zones creates sustained Twitter buzz (rather than a single spike at UTC midnight), while also spreading soul-gen load
- **Internal users** (`USER_TYPE === 'ant'`) always have access

### 3.7 Deterministic Seed System

```typescript
const SALT = 'friend-2026-401'  // Hints at April 1st (4/01)

export function roll(userId: string): Roll {
  const key = userId + SALT
  const rng = mulberry32(hashString(key))
  // Each user's companion is entirely determined by userId
}
```

Bones (skeleton) are deterministically derived from hash(userId) and never persisted; Soul (name, personality) is model-generated and stored in config. This means users cannot fake rarity by editing config files.

---

## IV. Undercover Mode

### 4.1 Complete Trigger Logic

Located at `utils/undercover.ts`:

```typescript
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    // Force enable
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true
    // Auto mode: enable unless confirmed to be in an internal repo
    return getRepoClassCached() !== 'internal'
  }
  return false  // Always false for external builds
}
```

**Three states**:
1. `CLAUDE_CODE_UNDERCOVER=1` -- Force ON (even in internal repos)
2. Auto mode (default) -- OFF only when `getRepoClassCached() === 'internal'`
3. **No force-OFF** -- this is an intentional security design

### 4.2 Complete Injected Prompt

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

### 4.3 Technical Reason It Cannot Be Disabled

The source comment explicitly states:

> There is NO force-OFF. This guards against model codename leaks -- if we're not confident we're in an internal repo, we stay undercover.

Design philosophy: safe default is ON. Since Claude may push to public repos from non-git directories (e.g., `/tmp`), when it cannot reliably determine whether the target is a public repo, it errs on the side of protection.

### 4.4 Scope of Impact

Undercover mode affects:
- `commit.ts` / `commit-push-pr.ts` -- commit messages and PR content
- `prompts.ts` -- model self-awareness in system prompts
- `PromptInputFooter.tsx` -- UI display
- `attribution.ts` -- attribution information
- `setup.ts` -- repo classification during initialization

### 4.5 Ethical Analysis

This is a fascinating design: when Anthropic's internal employees contribute code to public repositories using Claude Code, the AI is instructed to **conceal the fact that it is an AI**. This raises discussions about AI-generated code transparency. From Anthropic's perspective, this is primarily to prevent internal codename leaks (a security concern), but the side effect is blurring the contribution boundary between humans and AI.

---

## V. GrowthBook Integration Deep Dive

### 5.1 Three-Way SDK Key Strategy

`constants/keys.ts`:

```typescript
export function getGrowthBookClientKey(): string {
  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'   // Internal dev environment
      : 'sdk-xRVcrliHIlrg4og4'   // Internal production environment
    : 'sdk-zAZezfDKGoZuXXKe'     // External users
}
```

Three-tier usage:
1. **External** (sdk-zAZ...): Feature configuration for all public users
2. **Internal production** (sdk-xRV...): Daily configuration for Anthropic employees
3. **Internal dev** (sdk-yZQ...): Experimental environment when `ENABLE_GROWTHBOOK_DEV` is enabled

### 5.2 Three-Level Priority Implementation

Priority chain for value resolution in `services/analytics/growthbook.ts`:

```
1. Environment variable CLAUDE_INTERNAL_FC_OVERRIDES (JSON, ant-only)
   |-- Highest priority, for deterministic eval harness testing
2. Local config getGlobalConfig().growthBookOverrides (/config Gates tab)
   |-- ant-only, modifiable at runtime
3. Remote evaluation remoteEvalFeatureValues (GrowthBook Remote Eval)
   |-- Fetched from server, takes effect in real-time
4. Disk cache cachedGrowthBookFeatures (~/.claude.json)
   |-- Fallback when network is unavailable
5. Hardcoded defaults (defaultValue parameter at call site)
```

### 5.3 Disk Cache Mechanism

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

Key design points:
- **Full replacement** (not merge): Flags deleted server-side disappear locally
- **Writes only on success**: Timeout/failure paths do not write, preventing cache "poisoning"
- **Empty payload protection**: `Object.keys(payload.features).length === 0` is skipped, preventing empty objects from overwriting
- Storage location: `cachedGrowthBookFeatures` field in `~/.claude.json`

### 5.4 Exposure Logging

```typescript
// Deduplication: each feature logged at most once per session
const loggedExposures = new Set<string>()
// Deferred logging: features accessed before init completes go into pendingExposures
const pendingExposures = new Set<string>()
```

---

## VI. Complete Decoding of the "Tengu" Project Codename

**"Tengu" is the internal codename for Claude Code**. Evidence is found throughout the entire codebase:

### 6.1 Telemetry Event Naming

All top-level telemetry events use the `tengu_` prefix:

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

### 6.2 GrowthBook Feature Flag Naming

Runtime configuration also uses the `tengu_` prefix, followed by random word pairs (codename style):

| Flag | Purpose |
|------|------|
| `tengu_attribution_header` | Attribution header toggle |
| `tengu_frond_boric` | Telemetry sink killswitch |
| `tengu_log_datadog_events` | Datadog event gating |
| `tengu_event_sampling_config` | Event sampling configuration |
| `tengu_1p_event_batch_config` | First-party event batch configuration |
| `tengu_cobalt_frost` | Nova 3 voice engine gating |
| `tengu_onyx_plover` | Auto-dream parameters (minHours/minSessions) |
| `tengu_harbor` | Channel notification runtime gating |
| `tengu_hive_evidence` | Verification agent gating |
| `tengu_ant_model_override` | Internal model override |
| `tengu_max_version_config` | Version limit |
| `tengu_hawthorn_window` | Per-message tool result character budget |
| `tengu_tool_pear` | Tool-related configuration |
| `tengu_session_memory` | Session memory gating |
| `tengu_sm_config` | Session memory configuration |
| `tengu_strap_foyer` | Settings sync download gating |
| `tengu_enable_settings_sync_push` | Settings sync upload gating |
| `tengu_sessions_elevated_auth_enforcement` | Session elevated authentication |
| `tengu_cicada_nap_ms` | Background refresh throttling |
| `tengu_miraculo_the_bard` | Concurrent session gating |
| `tengu_kairos` | KAIROS mode runtime gating |
| `tengu_bridge_repl_v2_cse_shim_enabled` | Bridge session ID compatibility shim |
| `tengu_amber_quartz_disabled` | Voice mode killswitch |

**Naming convention**: `tengu_` + random adjective/noun pair (e.g., `cobalt_frost`, `onyx_plover`). This is a common internal codename style that prevents flag names from revealing feature intent.

### 6.3 Tengu Reference in `product.ts`

```typescript
// The cse_->session_ translation is a temporary shim gated by
// tengu_bridge_repl_v2_cse_shim_enabled
```

This confirms that "tengu" is not just a telemetry prefix, but an identifier for the entire project infrastructure.

---

## VII. Other Hidden Features

### 7.1 Voice Mode

`voice/voiceModeEnabled.ts` reveals:
- Requires Anthropic OAuth authentication (uses claude.ai's voice_stream endpoint)
- `tengu_amber_quartz_disabled` serves as the killswitch (not disabled by default, available on new installs)
- Not supported with API Key, Bedrock, Vertex, or Foundry

### 7.2 MoreRight

`moreright/useMoreRight.tsx` is a **stub for external builds**:

```typescript
// Stub for external builds -- the real hook is internal only.
export function useMoreRight(_args: {...}): {
  onBeforeQuery, onTurnComplete, render
} {
  return { onBeforeQuery: async () => true, onTurnComplete: async () => {}, render: () => null };
}
```

The real implementation is only available in internal builds. The exact functionality is unknown, but the interface suggests it is a pre/post query interception layer.

### 7.3 NATIVE_CLIENT_ATTESTATION

Native client attestation in `system.ts`:

```typescript
// cch=00000 placeholder is overwritten by Bun's native HTTP stack
// with a computed hash. The server verifies this token to confirm
// the request came from a real Claude Code client.
// See bun-anthropic/src/http/Attestation.zig
```

A Zig-implemented native HTTP layer replaces `cch=00000` with a computed hash before the request is sent, used for server-side verification that the request originates from a genuine Claude Code client (anti-spoofing). Fixed-length placeholders are used to avoid Content-Length changes and buffer reallocation.

### 7.4 "Capybara" Model Codename

Multiple comments in `prompts.ts` and `undercover.ts` confirm:
- `@[MODEL LAUNCH]: Update comment writing for Capybara` -- Capybara is an upcoming/released model
- The Undercover prompt explicitly lists "animal names like Capybara, Tengu" as internal codenames that must be hidden
- The capybara species name in `buddy/types.ts` is encoded with `fromCharCode` precisely because it conflicts with the model codename

---

## VIII. Summary of All 21 Files in constants/

| File | Lines | Core Content |
|------|------|---------|
| `apiLimits.ts` | 95 | Image 5MB base64, PDF 100 pages, media 100/request |
| `betas.ts` | 53 | 20+ Beta headers, including `token-efficient-tools-2026-03-28` |
| `common.ts` | 34 | Date utilities, memoized session date |
| `cyberRiskInstruction.ts` | 24 | Security boundary instructions maintained by the Safeguards team |
| `errorIds.ts` | 15 | Obfuscated error IDs (current Next ID: 346) |
| `figures.ts` | 46 | Unicode status indicators, Bridge spinner |
| `files.ts` | 157 | Binary extension set, content detection |
| `github-app.ts` | 144 | GitHub Action workflow templates |
| `keys.ts` | 11 | Three-tier GrowthBook SDK keys |
| `messages.ts` | 1 | `NO_CONTENT_MESSAGE` |
| `oauth.ts` | 235 | Full OAuth configuration (prod/staging/local/FedStart) |
| `outputStyles.ts` | 216 | Built-in output styles: Default/Explanatory/Learning |
| `product.ts` | 77 | Product URLs, remote sessions, tengu shim |
| `prompts.ts` | 500+ | Core system prompts, KAIROS/Proactive/Undercover injection points |
| `spinnerVerbs.ts` | 205 | 204 loading verbs (Clauding, Gitifying...) |
| `system.ts` | 96 | System prefix, attribution headers, client attestation |
| `systemPromptSections.ts` | 69 | System prompt section caching framework |
| `toolLimits.ts` | 57 | Tool result 50K character/100K token limits |
| `tools.ts` | 113 | Agent tool whitelist/blacklist |
| `turnCompletionVerbs.ts` | 13 | Completion verbs (Baked, Brewed...) |
| `xml.ts` | 87 | XML tag constants (tick, task, channel, fork...) |

---

## IX. Product Direction Summary

From the panoramic view of Feature Flags, Claude Code's evolution trajectory is clear:

1. **From tool to assistant** (KAIROS): Sleep/Wake cycles, proactive notifications, channel listening -- all pointing toward "always-on AI"
2. **From monolith to swarm** (Coordinator/Fork/Swarm): Multi-agent collaboration, UDS cross-process communication, team memory sync
3. **From text to multimodal** (Voice/Browser/Image): Voice mode, built-in browser, native clipboard images
4. **From local to remote** (Bridge/CCR/SSH): Remote development environments, auto-connect, mirror sync
5. **From stateless to memory-endowed** (Dream/SessionMemory/TeamMem): Automatic dream-based memory consolidation, session memory persistence, team knowledge sync
6. **From trust to verification** (Attestation/AntiDistillation/Verification): Client attestation, anti-distillation, adversarial verification agents

Claude Code is no longer just a coding assistant -- it is becoming a **distributed, multi-agent, persistently-memoried, proactively-aware AI development partner platform**.
