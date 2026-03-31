# 05 - Context Management and Compression System (Deep Analysis)

## 1. System Architecture Overview

Claude Code's context management is a sophisticated multi-layered system. The core challenge lies in the fact that the information volume of long coding sessions far exceeds the model's context window (200K tokens by default, up to 1M tokens), requiring a dynamic balance between "information completeness" and "window limitations." The system employs a three-tier compression architecture -- Microcompact -> Session Memory Compact -> Full Compact -- each tier with its own independent trigger conditions, implementation strategies, and information retention policies.

---

## 2. Precise Token Counting Implementation

### 2.1 `tokenCountWithEstimation()` -- The Core Metric Function

This is the **sole authoritative entry point** for the system to gauge context usage. All threshold decisions (auto-compaction, session memory initialization, etc.) rely on it. Its algorithm is a hybrid strategy of "API precise values + rough incremental estimation":

```typescript
// utils/tokens.ts
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  // Search backward from the end of messages for the last assistant message with usage data
  let i = messages.length - 1
  while (i >= 0) {
    const usage = getTokenUsage(messages[i])
    if (usage) {
      // Key: handle parallel tool call backtracking
      const responseId = getAssistantMessageId(messages[i])
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const priorId = getAssistantMessageId(messages[j])
          if (priorId === responseId) i = j      // Earlier split record from the same API response
          else if (priorId !== undefined) break   // Different API response encountered, stop
          j--
        }
      }
      // Precise value + rough estimation for subsequently added messages
      return getTokenCountFromUsage(usage) + roughTokenCountEstimationForMessages(messages.slice(i + 1))
    }
    i--
  }
  // When there are no API responses at all, use rough estimation for everything
  return roughTokenCountEstimationForMessages(messages)
}
```

**Algorithm Key Points**:
1. **Precise Baseline**: Obtains the accurate token count from the `usage` field of the most recent API response, including `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`
2. **Incremental Estimation**: Messages added after the baseline (such as tool results) are supplemented using rough estimation via `roughTokenCountEstimation()`
3. **Parallel Tool Call Backtracking**: When the model issues multiple tool calls at once, the streaming code splits each content block into separate assistant records (sharing the same `message.id`), and the query loop interleaves tool_result entries. If calculation starts only from the last assistant record, the interleaved tool_results preceding it would be missed. Backtracking to the first assistant record with the same `message.id` ensures all interleaved tool_results are included in the estimation

### 2.2 Rough Estimation Implementation

```typescript
// services/tokenEstimation.ts
export function roughTokenCountEstimation(content: string, bytesPerToken = 4): number {
  return Math.round(content.length / bytesPerToken)
}
```

**Counting Strategies for Different Content Types**:
- **text**: `content.length / 4`
- **tool_use**: length of `block.name + JSON.stringify(block.input)` / 4
- **tool_result**: recursively computes the content array
- **image / document**: fixed return of `2000` (`IMAGE_MAX_TOKEN_SIZE` constant), regardless of actual dimensions. The reason is that image tokens = `(width * height) / 750`, and the API constrains images to within 2000x2000, yielding a maximum of approximately 5333 tokens -- a conservative value is used
- **thinking**: only computes the text length of `block.thinking`, excludes the signature
- **redacted_thinking**: computes the length of `block.data`
- **JSON files**: special handling with `bytesPerToken` of 2 (JSON has many single-character tokens like `{`, `:`, `,`)

### 2.3 API Precise Counting

```typescript
// services/tokenEstimation.ts
export async function countTokensWithAPI(content: string): Promise<number | null> {
  // Calls the anthropic.beta.messages.countTokens API
  const response = await anthropic.beta.messages.countTokens({
    model: normalizeModelStringForAPI(model),
    messages: [...],
    tools,
    ...(containsThinking && { thinking: { type: 'enabled', budget_tokens: 1024 } }),
  })
  return response.input_tokens
}
```

**Fallback Strategy**: When the primary model API is unavailable (e.g., Vertex global region does not support Haiku), `countTokensViaHaikuFallback()` is used to obtain the input token count by sending a request with `max_tokens: 1`.

---

## 3. Complete Implementation of the Three-Tier Compression

### 3.1 Microcompact -- The First Line of Defense

The core idea behind microcompact is: **preserve the conversation structure while only clearing old tool output content**. It has three sub-paths.

#### 3.1.1 Time-Based Microcompact (Time-Based MC)

**Trigger Condition**: More than a configured number of minutes have elapsed since the last assistant message (default 60 minutes, dynamically delivered via GrowthBook's `tengu_slate_heron` configuration).

**Design Rationale**: The server-side prompt cache TTL is approximately 1 hour. After timeout, the cache will inevitably expire and the entire prefix will be rewritten -- clearing old tool_results before rewriting reduces the rewrite volume.

```typescript
// Trigger evaluation
export function evaluateTimeBasedTrigger(messages, querySource) {
  const config = getTimeBasedMCConfig()
  // Must be a main thread request (prefix match 'repl_main_thread')
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) return null
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (gapMinutes < config.gapThresholdMinutes) return null
  return { gapMinutes, config }
}
```

**Information Retention Policy**: Retains results from the most recent `keepRecent` (default 5, minimum 1) compactable tools; all others are replaced with `'[Old tool result content cleared]'`.

**Compactable Tool Allowlist**: `FileRead, BashTool, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite`.

#### 3.1.2 Cached Microcompact (Cached MC)

This is the most elegant path -- leveraging Anthropic API's `cache_edits` feature to delete old tool results **without breaking the server-side prompt cache**.

**Core Mechanism**:
1. **No local message modification**: Message content remains unchanged; the API layer uses `cache_reference` and `cache_edits` directives to instruct the server to delete results for specified `tool_use_id`s
2. **State Tracking**: Maintains `CachedMCState`, which includes `registeredTools` (registered tool IDs), `toolOrder` (registration order), `deletedRefs` (deleted references), and `pinnedEdits` (pinned edits that must be resent in subsequent requests to maintain cache hits)
3. **Count-based Trigger**: When the number of registered tools exceeds `triggerThreshold`, the oldest tool results are deleted while retaining the most recent `keepRecent` entries

```typescript
// Consume pending cache edits (called during API request assembly)
export function consumePendingCacheEdits() {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}
```

**Beta Header Latch Mechanism**: Once cached MC triggers for the first time, `setCacheEditingHeaderLatched(true)` locks the beta header, and all subsequent requests carry this header. This avoids a mid-session toggle changing the server-side cache key, which would cause a cache bust of approximately 50-70K tokens.

#### 3.1.3 API-Native Microcompact (apiMicrocompact.ts)

Achieves server-side cleanup through Anthropic API's `context_management` parameter, supporting two strategies:
- `clear_tool_uses_20250919`: triggered by `input_tokens`, clears old tool results/inputs
- `clear_thinking_20251015`: clears old thinking blocks

```typescript
export function getAPIContextManagement(options) {
  const strategies: ContextEditStrategy[] = []
  // Thinking block cleanup (non-redact mode)
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }
  // Tool result cleanup (ant-only)
  if (useClearToolResults) {
    strategies.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 180_000 },
      clear_at_least: { type: 'input_tokens', value: 140_000 },
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
    })
  }
}
```

### 3.2 Session Memory Compact -- The Second Line of Defense

**Core Idea**: Use asynchronously pre-extracted session memory as a summary to replace old messages, avoiding additional API calls.

**Forked Agent Mechanics**: The extraction of session memory (not the compaction itself) is executed via `runForkedAgent`. The forked agent reuses the parent thread's prompt cache (`cacheSafeParams.forkContextMessages` passes in all messages from the main conversation), runs in an isolated context with `maxTurns: 1`, and uses `NO_TOOLS_PREAMBLE` to prevent tool calls -- producing only text output.

**Trigger and Execution Flow**:
```typescript
// autoCompact.ts -- prioritized attempt within autoCompactIfNeeded
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages, toolUseContext.agentId, recompactionInfo.autoCompactThreshold)
if (sessionMemoryResult) {
  // If successful, skip full compaction
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}
```

**Message Retention Policy** (`calculateMessagesToKeepIndex`):

Starting from `lastSummarizedMessageId` (the last message ID processed by the session memory extractor), it expands forward until two minimum requirements are met:
- `minTokens`: 10,000 (retain at least 10K tokens of recent messages)
- `minTextBlockMessages`: 5 (retain at least 5 messages containing text)
- `maxTokens`: 40,000 (hard cap -- stops expanding even if the above conditions are not met)

It must also maintain API invariants: never split `tool_use/tool_result` pairs, and never separate thinking blocks that share the same `message.id`.

**Post-Compaction Validation**: If the token count after compaction still exceeds `autoCompactThreshold`, the SM compaction is abandoned and the system falls back to full compaction.

### 3.3 Full Compact -- The Last Resort

**Execution Flow**: Invokes the forked agent via `compactConversation()`, sending the entire conversation to the model to generate a structured summary.

**9-Section Structured Summary Prompt Template** (`prompt.ts`):

```
Your task is to create a detailed summary of the conversation so far...

1. Primary Request and Intent: Capture all of the user's explicit requests and intent
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks
3. Files and Code Sections: Enumerate files inspected/modified/created, including complete code snippets
4. Errors and fixes: List all errors encountered and how they were fixed, with special attention to user feedback
5. Problem Solving: Document resolved problems and ongoing troubleshooting
6. All user messages: List all non-tool-result user messages (key to understanding user feedback and shifting intent)
7. Pending Tasks: Outline explicit tasks that are not yet completed
8. Current Work: Precisely describe the current work before the compaction request, including file names and code snippets
9. Optional Next Step: List the next step directly related to the most recent work, must reference the original conversation
```

**Key Design Decisions**:
- **`<analysis>` Scratchpad**: Requires the model to organize its thoughts in an `<analysis>` tag first, then output the final summary in `<summary>`. `formatCompactSummary()` **strips** the analysis portion during post-processing, retaining only the summary. This effectively trades extra output tokens for higher summary quality
- **NO_TOOLS_PREAMBLE**: Includes a mandatory declaration at the beginning stating "do not call any tools," with a repeat reminder at the end. Because the forked agent inherits the parent thread's full tool set (for cache-key matching), on Sonnet 4.6+ the model may attempt tool calls, wasting the `maxTurns: 1` budget
- **Partial Compact Variants**: Supports both `from` (summarize starting from a certain message) and `up_to` (summarize up to a certain message) directions, each with its own dedicated prompt

**Post-Compaction Reconstruction**:
```typescript
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,     // Compaction boundary marker (with metadata)
    ...result.summaryMessages,  // Summary
    ...(result.messagesToKeep ?? []),  // Retained recent messages
    ...result.attachments,      // File snapshots, plans, skills, etc.
    ...result.hookResults,      // Output from session start hooks
  ]
}
```

After compaction, the system also: re-injects recently read files (up to 5, each capped at 5K tokens), re-injects invoked skill content (each capped at 5K tokens, total budget of 25K), runs session start hooks, and resends the delta for deferred tools / agent listing / MCP instructions.

---

## 4. Auto-Compaction Trigger Mechanism

### 4.1 Threshold Calculation

```typescript
// autoCompact.ts
export function getEffectiveContextWindowSize(model: string): number {
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW environment variable can override
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    contextWindow = Math.min(contextWindow, parseInt(autoCompactWindow, 10))
  }
  // Subtract output reserved space (min(model max output, 20K))
  return contextWindow - reservedTokensForSummary
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // Subtract 13,000
}
```

**Calculation Example with a 200K Window**:
- `effectiveContextWindow` = 200,000 - min(32,000, 20,000) = **180,000**
- `autoCompactThreshold` = 180,000 - 13,000 = **167,000**
- **Trigger Percentage** = 167,000 / 200,000 = **83.5%**

**Calculation Example with a 1M Window**:
- `effectiveContextWindow` = 1,000,000 - 20,000 = **980,000**
- `autoCompactThreshold` = 980,000 - 13,000 = **967,000**
- **Trigger Percentage** = 967,000 / 1,000,000 = **96.7%**

> Note: The 92.8% mentioned in earlier analysis was an intermediate calculation. The actual threshold varies by model and window size.

**Purpose of `CLAUDE_CODE_AUTO_COMPACT_WINDOW`**: Allows users to artificially reduce the effective context window. For example, setting it to 200000 under a 1M window causes auto-compaction to trigger around 200K instead of waiting until near 1M. This is useful for users who want to control the cost of individual API calls.

### 4.2 Circuit Breaker

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export async function autoCompactIfNeeded(...) {
  // Stop retrying after reaching the consecutive failure limit
  if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false }
  }

  try {
    const compactionResult = await compactConversation(...)
    return { wasCompacted: true, consecutiveFailures: 0 }  // Reset on success
  } catch (error) {
    const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging('autocompact: circuit breaker tripped...')
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
```

**Design Context**: BQ data from 2026-03-10 showed that 1,279 sessions experienced 50+ consecutive failures (maximum 3,272), wasting approximately 250K API calls per day. The circuit breaker trips after 3 consecutive failures, halting further auto-compaction attempts for the current session. A single success resets the counter.

### 4.3 Recursion Guard and Context Collapse Mutual Exclusion

`shouldAutoCompact()` includes multiple recursion safeguards:
- Requests originating from `session_memory` and `compact` sources are skipped directly (to avoid deadlocks)
- Requests from `marble_origami` (the context collapse agent) are skipped (to avoid corrupting main thread state)
- **Context Collapse Mutual Exclusion**: When the context collapse system is enabled, auto-compaction is completely disabled. This is because the collapse system operates between 90% commit / 95% blocking thresholds, while auto-compaction triggers at approximately 93%, which would create contention

---

## 5. Cost Tracking

### 5.1 Token Classification

```typescript
// cost-tracker.ts
export function addToTotalSessionCost(cost: number, usage: Usage, model: string) {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  // Count by type
  getTokenCounter()?.add(usage.input_tokens, { model, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { model, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, { model, type: 'cacheRead' })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, { model, type: 'cacheCreation' })
}
```

**Four Token Categories**:
- `input_tokens`: regular input (portions that did not hit the cache)
- `cache_creation_input_tokens`: tokens for first-time cache writes (higher priced, e.g., Sonnet at $3.75/Mtok vs. regular $3/Mtok)
- `cache_read_input_tokens`: cache hit reads (lowest priced, e.g., Sonnet at $0.30/Mtok)
- `output_tokens`: model output

### 5.2 Cost Calculation Model

```typescript
// utils/modelCost.ts pricing tier examples
COST_TIER_3_15 = {        // Sonnet series
  inputTokens: 3,         // $3/Mtok
  outputTokens: 15,       // $15/Mtok
  promptCacheWriteTokens: 3.75,  // $3.75/Mtok
  promptCacheReadTokens: 0.3,    // $0.30/Mtok
}
COST_TIER_15_75 = {       // Opus 4/4.1
  inputTokens: 15,        // $15/Mtok
  outputTokens: 75,       // $75/Mtok
}
```

### 5.3 Session Cost Persistence

```typescript
// Save to project configuration file
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [model, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costUSD: usage.costUSD,
      }]),
    ),
    lastSessionId: getSessionId(),
  }))
}
```

During restoration, `restoreCostStateForSession(sessionId)` matches against `lastSessionId` -- only the same session will have its cumulative costs restored.

---

## 6. Context Window Extension -- 1M Token Support

### 6.1 Enablement Conditions

```typescript
// utils/context.ts
export function getContextWindowForModel(model: string, betas?: string[]): number {
  // 1. Environment variable override (ant-only)
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) { return parseInt(...) }
  // 2. [1m] suffix -- explicit client opt-in
  if (has1mContext(model)) { return 1_000_000 }  // /\[1m\]/i.test(model)
  // 3. Model capability query
  if (cap?.max_input_tokens >= 100_000) { return cap.max_input_tokens }
  // 4. Beta header signal
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) { return 1_000_000 }
  // 5. A/B experiment
  if (getSonnet1mExpTreatmentEnabled(model)) { return 1_000_000 }
  // 6. Default 200K
  return 200_000
}
```

**Models Supporting 1M**: `claude-sonnet-4` (including 4.6) and `claude-opus-4-6`.

**HIPAA Compliance Toggle**: The `CLAUDE_CODE_DISABLE_1M_CONTEXT` environment variable forcibly disables 1M, falling back to 200K even if the model capability report indicates support.

### 6.2 Beta Header Latch Mechanism

```typescript
// services/api/claude.ts
// Sticky-on latches for dynamic beta headers. Each header, once first
// sent, keeps being sent for the rest of the session so mid-session
// toggles don't change the server-side cache key and bust ~50-70K tokens.
// Latches are cleared on /clear and /compact via clearBetaHeaderLatches().

let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
if (!cacheEditingHeaderLatched && cachedMCEnabled &&
    getAPIProvider() === 'firstParty' &&
    options.querySource === 'repl_main_thread') {
  cacheEditingHeaderLatched = true
  setCacheEditingHeaderLatched(true)
}
```

**Latch Principle**: Beta headers are part of the server-side prompt cache key. If a header is added or removed mid-session, the cache key changes and the previously cached 50-70K tokens of prompt prefix are entirely invalidated. The latch mechanism ensures that once a header is first sent, it **remains sent permanently** until explicitly cleared by `/clear` or `/compact`.

**Existing Latches**:
- `afkModeHeaderLatched`: AFK mode
- `fastModeHeaderLatched`: fast mode
- `cacheEditingHeaderLatched`: cache editing (cached MC)
- `thinkingClearLatched`: thinking cleanup (triggered when idle > 1h)

---

## 7. Message Grouping and Partial Compaction

### 7.1 API Round Grouping

```typescript
// grouping.ts
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  // Group by assistant message.id boundaries
  // Streaming chunks from the same API response share the same id and stay in the same group
  // Correctly handles [tu_A(id=X), result_A, tu_B(id=X)] scenarios
}
```

This is the foundation for the "discard oldest group" strategy during compaction retries. When a compaction request itself triggers `prompt_too_long` (CC-1180), `truncateHeadForPTLRetry()` discards the oldest message groups by API round group, retrying up to 3 times.

### 7.2 Token Budget System

Users can specify a token budget using natural language (e.g., `+500k`, `use 2M tokens`), which the system parses via regex:

```typescript
// utils/tokenBudget.ts
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
```

The budget tracker monitors output tokens per turn, determines whether to continue at 90% completion, and detects diminishing returns (stops if 3 consecutive turns produce increments of fewer than 500 tokens).

---

## 8. Post-Compaction Cleanup (postCompactCleanup)

After compaction, multiple global states need to be reset:

```typescript
export function runPostCompactCleanup(querySource?: QuerySource): void {
  resetMicrocompactState()            // Clear cached MC state
  resetContextCollapse()              // Clear context collapse state (main thread only)
  getUserContext.cache.clear?.()      // Clear CLAUDE.md cache (main thread only)
  resetGetMemoryFilesCache('compact') // Reset memory file cache
  clearSystemPromptSections()         // Clear system prompt sections
  clearClassifierApprovals()          // Clear classifier approvals
  clearSpeculativeChecks()            // Clear speculative checks
  clearBetaTracingState()             // Clear beta tracing state
  clearSessionMessagesCache()         // Clear session messages cache
  // Note: does not clear invoked skill content (must persist across compactions)
  // Note: does not reset sentSkillNames (to avoid re-injecting ~4K tokens of skill_listing)
}
```

**Sub-Agent Protection**: Uses `querySource` to determine whether this is a main thread compaction. Sub-agents (`agent:*`) share module-level state with the main thread; if a sub-agent resets the main thread's state during compaction (such as the context-collapse store or getUserContext cache), it would corrupt main thread data.

---

## 9. Design Trade-offs Summary

1. **Precision vs. Performance**: `tokenCountWithEstimation` combines API precise values with character-length rough estimation. In most scenarios the deviation is manageable (the rough estimation portion uses a 4/3 amplification factor for conservative estimates), avoiding the latency of calling the count tokens API every time

2. **Cache Protection vs. Information Retention**: Cached MC sacrifices some information (deleting old tool results) in exchange for prompt cache hit rates. Time-based MC only triggers when the cache will inevitably expire, making it the most "lossless" microcompact timing

3. **Progressive Relationship of the Three Compression Tiers**: Microcompact has zero API call cost, session memory compact reuses existing asynchronous extraction results, and full compact incurs complete API call overhead. Priority escalates from lowest cost to highest cost

4. **Circuit Breaker Conservatism**: Tripping after 3 failures may seem aggressive, but considering that each compaction itself consumes a large number of tokens (p99.99 output is 17,387 tokens), 3 consecutive failures means over 50K output tokens have already been wasted, and the context is likely "irrecoverably" over the limit

5. **Session-Scoped Latches**: Beta header latches guarantee cache stability within a session, but also mean that certain features cannot be dynamically toggled mid-session. This is an explicit design choice of "cache efficiency over feature flexibility"
