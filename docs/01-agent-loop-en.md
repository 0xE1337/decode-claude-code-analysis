# 01 - Agent Loop Core Loop: In-Depth Architecture Analysis

## Overview

Claude Code's Agent Loop is a multi-layered nested loop architecture based on AsyncGenerator, responsible for managing the complete lifecycle of "user input -> model inference -> tool execution -> result feedback". The core consists of three layers:

1. **QueryEngine** (`QueryEngine.ts`, ~1295 lines): A session-level manager that owns state such as message history, usage statistics, and permission tracking. Each `submitMessage()` initiates a new turn.
2. **query() / queryLoop()** (`query.ts`, ~1729 lines): The core `while(true)` loop of a single turn, responsible for repeatedly calling the model API, executing tools, and handling error recovery until the model no longer requests tool calls.
3. **Auxiliary modules** (`query/` directory): Configuration snapshots (`config.ts`), dependency injection (`deps.ts`), stop hooks (`stopHooks.ts`), token budget (`tokenBudget.ts`).

**Key design philosophy**: The entire architecture uses `AsyncGenerator` + `yield*` delegation to implement a lazy-evaluated streaming pipeline. Each layer can yield messages to the caller (SDK/REPL) while maintaining the operation of its own state machine. This is not a DAG, not a ReAct framework, nor a Plan-Execute system — it is a carefully designed imperative state machine with deterministic state transitions formed by 7 explicit `continue` sites.

---

## I. queryLoop Complete State Machine Reconstruction

### 1.1 State Structure: The Complete Memory of the Loop

```typescript
// query.ts:204-217
type State = {
  messages: Message[]                          // 当前消息数组（每次 continue 都重建）
  toolUseContext: ToolUseContext                // 工具执行上下文（含 abort 信号）
  autoCompactTracking: AutoCompactTrackingState // 自动压缩追踪（turnId, turnCounter, 失败次数）
  maxOutputTokensRecoveryCount: number          // max_output_tokens 多轮恢复计数（上限3）
  hasAttemptedReactiveCompact: boolean          // 是否已尝试响应式压缩（单次守卫）
  maxOutputTokensOverride: number | undefined   // 输出 token 上限覆盖（escalate 时设 64k）
  pendingToolUseSummary: Promise<...>           // 上一轮工具执行的摘要（Haiku 异步生成）
  stopHookActive: boolean | undefined           // stop hook 是否处于活跃状态
  turnCount: number                             // 当前回合数
  transition: Continue | undefined              // 上一次 continue 的原因（测试可断言）
}
```

Key design: State uses **full replacement** rather than partial assignment. Each `continue` site creates an entirely new State object assigned to `state`. This provides three benefits: (1) Atomicity of state transitions — no dirty state from partially completed assignments; (2) Clear and auditable intent for each continue path — inspecting the State construction reveals which fields are reset and which are preserved; (3) The `transition.reason` field allows tests to assert which recovery path was taken.

### 1.2 Complete State Machine Diagram

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                   while(true) 入口                       │
                    │  解构 state -> 预处理管线(snip/micro/collapse/auto)       │
                    │  -> 阻塞限制检查 -> API 调用                             │
                    └────────────────────┬─────────────────────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────────────────────┐
                    │              API 流式响应处理                              │
                    │  withheld 暂扣(PTL/MOT/media) | 收集 tool_use blocks     │
                    │  FallbackTriggered -> 内层 continue (fallback retry)     │
                    └────────────────────┬─────────────────────────────────────┘
                                         │
                         ┌───────────────▼───────────────┐
                         │        abort 检查 #1           │
                         │   (流式完成后)                  │
                         │   aborted -> return            │
                         │   'aborted_streaming'          │
                         └───────────┬───────────────────┘
                                     │
                    ┌────────────────▼────────────────────┐
                    │      needsFollowUp == false?        │
                    │      (模型没有请求工具调用)           │
                    └──┬───────────────────────────────┬──┘
                       │ YES                           │ NO
          ┌────────────▼────────────┐    ┌─────────────▼──────────────┐
          │   无工具调用退出路径      │    │   工具执行路径              │
          │                         │    │                            │
          │ [1] collapse_drain_retry│    │   streamingToolExecutor    │
          │ [2] reactive_compact    │    │   .getRemainingResults()   │
          │ [3] MOT escalate        │    │   或 runTools()            │
          │ [4] MOT recovery        │    │                            │
          │ [5] stop_hook_blocking  │    │   abort 检查 #2            │
          │ [6] token_budget_cont.  │    │   (工具执行后)              │
          │ [*] return completed    │    │   aborted -> return        │
          └─────────────────────────┘    │   'aborted_tools'          │
                                          │                            │
                                          │   附件收集                  │
                                          │   memory/skill prefetch    │
                                          │                            │
                                          │   maxTurns 检查             │
                                          │   exceeded -> return        │
                                          │                            │
                                          │ [7] next_turn continue     │
                                          └────────────────────────────┘
```

### 1.3 Precise Trigger Conditions and State Transitions for the Seven Continue Sites

| # | transition.reason | Trigger Condition | Key State Changes | Code Location |
|---|---|---|---|---|
| 1 | `collapse_drain_retry` | PTL 413 error + CONTEXT_COLLAPSE enabled + last transition was not collapse_drain + drain committed > 0 | messages replaced with drained.messages; hasAttemptedReactiveCompact preserved | ~1099-1115 |
| 2 | `reactive_compact_retry` | (PTL 413 or media_size_error) + reactiveCompact succeeds | messages replaced with postCompactMessages; hasAttemptedReactiveCompact set to true | ~1152-1165 |
| 3 | `max_output_tokens_escalate` | MOT error + capEnabled + no prior override + no environment variable override | maxOutputTokensOverride set to ESCALATED_MAX_TOKENS (64k) | ~1207-1221 |
| 4 | `max_output_tokens_recovery` | MOT error + recoveryCount < 3 (escalate already used or unavailable) | messages appended with assistant + recovery meta; recoveryCount++ | ~1231-1252 |
| 5 | `stop_hook_blocking` | stop hook returns blockingErrors | messages appended with assistant + blockingErrors; hasAttemptedReactiveCompact preserved | ~1283-1306 |
| 6 | `token_budget_continuation` | TOKEN_BUDGET enabled + budget not reached 90% + not diminishing returns | messages appended with assistant + nudge; MOT recovery and reactiveCompact reset | ~1321-1341 |
| 7 | `next_turn` | Tool execution complete, preparing next turn | messages = forQuery + assistant + toolResults; turnCount++; MOT and reactive state reset | ~1715-1727 |

**Mutual Exclusion and Priority Relationships**:

Continue sites 1-6 are all within the `!needsFollowUp` branch (model did not request tool calls), and their priority follows a **waterfall** pattern:

```
PTL 413? ──Yes──> Try collapse drain [1]
                      │ drain ineffective
                      ▼
                  Try reactive compact [2]
                      │ compact fails
                      ▼
                  surface error + return

MOT? ──Yes──> Try escalate [3]
                  │ already escalated or unavailable
                  ▼
              Try multi-turn recovery [4] (max 3 times)
                  │ recovery attempts exhausted
                  ▼
              surface error (yield lastMessage)

isApiErrorMessage? ──Yes──> return (skip stop hooks to prevent death spiral)

stop hooks ──blocking──> [5] stop_hook_blocking (inject errors for model to fix)
           ──prevent──> return (terminate directly)

token budget ──continue──> [6] token_budget_continuation
             ──stop──> return completed
```

Continue 7 (`next_turn`) is at the end of the `needsFollowUp === true` branch, mutually exclusive with 1-6 — the model either requested tool calls (take path 7) or didn't (take one of 1-6 or return).

### 1.4 Key Defense Mechanism: Cross-Site Guard for hasAttemptedReactiveCompact

The management of this boolean reveals an elegant anti-infinite-loop design:

```typescript
// Continue #5 (stop_hook_blocking) 保留 hasAttemptedReactiveCompact:
{
  // ...
  hasAttemptedReactiveCompact,  // 不重置！
  // 注释: "Resetting to false here caused an infinite loop:
  //  compact -> still too long -> error -> stop hook blocking -> compact -> ..."
}

// Continue #7 (next_turn) 重置:
{
  hasAttemptedReactiveCompact: false,  // 新的一轮工具调用，可以再试
}
```

This means: if reactive compact has already been attempted, a stop hook triggered retry will not attempt compaction again. However, if a complete round of tool calls has passed (the model may have handled the context on its own), another attempt is allowed.

---

## II. Error Handling Layer-by-Layer Analysis

### 2.1 Complete Implementation of the "Withhold-then-Decide" Pattern

This is the Agent Loop's most ingenious error handling pattern. The core idea: **recoverable error messages are not immediately exposed to consumers; instead, they are withheld first, and after recovery logic runs, a decision is made to either discard (recovery succeeded) or expose (recovery failed)**.

#### Why Is Withhold Needed?

The comments reveal the motivation (query.ts:166-171):

```
Yielding early leaks an intermediate error to SDK callers (e.g. cowork/desktop)
that terminate the session on any `error` field — the recovery loop keeps running
but nobody is listening.
```

SDK consumers (such as the Desktop app) terminate the session upon receiving any error field. If an error is yielded before recovery succeeds, the consumer disconnects while the recovery loop continues running in vain — a classic "producer-consumer disconnect."

#### Four Categories of Withhold Targets

```typescript
// query.ts:799-825 — 流式循环内部
let withheld = false

// 1. Context Collapse 暂扣 PTL
if (feature('CONTEXT_COLLAPSE')) {
  if (contextCollapse?.isWithheldPromptTooLong(message, isPromptTooLongMessage, querySource)) {
    withheld = true
  }
}

// 2. Reactive Compact 暂扣 PTL
if (reactiveCompact?.isWithheldPromptTooLong(message)) {
  withheld = true
}

// 3. 媒体大小错误（图片/PDF 过大）
if (mediaRecoveryEnabled && reactiveCompact?.isWithheldMediaSizeError(message)) {
  withheld = true
}

// 4. Max Output Tokens
if (isWithheldMaxOutputTokens(message)) {
  withheld = true
}

// 暂扣的消息不 yield，但仍然 push 到 assistantMessages
// 这样后续恢复逻辑能找到它
if (!withheld) {
  yield yieldMessage
}
if (message.type === 'assistant') {
  assistantMessages.push(message)  // 无论是否 withheld 都收集
}
```

#### Decision Points for Recovery and Exposure

After the streaming loop ends, if `needsFollowUp === false`:

```
withheld PTL?
  ├── collapse drain succeeds -> continue [1] (error swallowed)
  ├── reactive compact succeeds -> continue [2] (error swallowed)
  └── both fail -> yield lastMessage (error exposed) + return

withheld MOT?
  ├── escalate -> continue [3] (error swallowed)
  ├── multi-turn recovery -> continue [4] (error swallowed)
  └── recovery exhausted -> yield lastMessage (error exposed)

withheld media?
  ├── reactive compact succeeds -> continue [2]
  └── fails -> yield lastMessage + return
```

#### Hoist Strategy for mediaRecoveryEnabled

```typescript
// query.ts:625-627
const mediaRecoveryEnabled = reactiveCompact?.isReactiveCompactEnabled() ?? false
```

The comments explain why this value is hoisted at the loop entry:

> `CACHED_MAY_BE_STALE can flip during the 5-30s stream, and withhold-without-recover would eat the message.`

If the gate is open when withholding is detected (message should be withheld), but the gate closes during recovery, the message is permanently "eaten" — the user sees neither the error nor the recovery. Hoisting ensures that withhold and recover see the same value.

### 2.2 Complete Recovery Path for Prompt-Too-Long (PTL)

PTL is the most commonly encountered error for the Agent — long conversations inevitably exceed the context window. The recovery path has three progressive levels:

**Level 1: Context Collapse Drain**

```typescript
// query.ts:1089-1116
if (feature('CONTEXT_COLLAPSE') && contextCollapse &&
    state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    // continue [1]: collapse_drain_retry
  }
}
```

Context Collapse in the normal flow is "deferred folding" — marking which messages can be folded but not yet executing the fold. During PTL, drain is triggered: immediately commit all deferred folds. `state.transition?.reason !== 'collapse_drain_retry'` prevents draining twice consecutively — if the retry after drain still results in PTL, this path is abandoned.

**Level 2: Reactive Compact**

```typescript
// query.ts:1119-1166
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    querySource,
    aborted: toolUseContext.abortController.signal.aborted,
    messages: messagesForQuery,
    cacheSafeParams: { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
  })
  if (compacted) {
    // task_budget 跨压缩边界追踪
    // continue [2]: reactive_compact_retry
  }
}
```

Reactive Compact is a full compaction operation (using the model to generate summaries), heavier but more thorough than drain. The `hasAttempted` guard ensures only a single attempt.

**Level 3: Expose Error**

```typescript
// query.ts:1172-1183
yield lastMessage  // 把暂扣的 PTL 错误暴露给消费者
void executeStopFailureHooks(lastMessage, toolUseContext)
return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
```

The comments specifically emphasize **the reason for not running stop hooks**:

> `Running stop hooks on prompt-too-long creates a death spiral: error -> hook blocking -> retry -> error -> ...`
> (hooks inject more tokens -> context grows larger -> more likely to trigger PTL -> infinite loop)

### 2.3 Recovery Path for Max Output Tokens (MOT)

MOT recovery is more complex than PTL because it has two phases:

**Phase 1: Escalation (Increase the Limit)**

```typescript
// query.ts:1195-1221
const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
if (capEnabled && maxOutputTokensOverride === undefined && !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  logEvent('tengu_max_tokens_escalate', { escalatedTo: ESCALATED_MAX_TOKENS })
  // continue [3]: max_output_tokens_escalate
  // maxOutputTokensOverride 设为 ESCALATED_MAX_TOKENS (64k)
}
```

Design details:
- `maxOutputTokensOverride === undefined` ensures escalation happens only once
- `!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` respects the user's explicit configuration
- Comments note `3P default: false (not validated on Bedrock/Vertex)` — not enabled for third-party providers

**Phase 2: Multi-turn Recovery**

```typescript
// query.ts:1223-1252
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {  // 限制 3 次
  const recoveryMessage = createUserMessage({
    content: `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
      `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
    isMeta: true,
  })
  // continue [4]: max_output_tokens_recovery
  // recoveryCount++
}
```

The wording of this recovery message is carefully crafted:
- "no apology, no recap" — prevents the model from wasting tokens repeating previous context
- "Pick up mid-thought" — handles cases where output was truncated mid-sentence
- "Break remaining work into smaller pieces" — guides the model to adaptively reduce output granularity
- `isMeta: true` — invisible to the UI, purely a control signal

### 2.4 Complete Flow for Fallback Model Switching

```typescript
// query.ts:893-951 — 内层 while(attemptWithFallback) 循环
catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true

    // 1. 清除孤立消息 — yield tombstones 让 UI 移除
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Model fallback triggered')
    for (const msg of assistantMessages) {
      yield { type: 'tombstone' as const, message: msg }
    }

    // 2. 重置状态
    assistantMessages.length = 0
    toolResults.length = 0
    toolUseBlocks.length = 0
    needsFollowUp = false

    // 3. 丢弃 StreamingToolExecutor 的待处理结果
    if (streamingToolExecutor) {
      streamingToolExecutor.discard()
      streamingToolExecutor = new StreamingToolExecutor(...)
    }

    // 4. 处理 thinking signature 不兼容
    if (process.env.USER_TYPE === 'ant') {
      messagesForQuery = stripSignatureBlocks(messagesForQuery)
    }

    // 5. 通知用户
    yield createSystemMessage(
      `Switched to ${renderModelName(...)} due to high demand for ${renderModelName(...)}`,
      'warning',
    )
    continue  // 内层循环重试
  }
  throw innerError
}
```

The tombstone mechanism deserves attention: during fallback, partial assistant messages have already been streamed out (including thinking blocks), and the thinking signatures of these messages are bound to the original model. If not cleared, replaying them to the new model causes a 400 error ("thinking blocks cannot be modified"). Tombstone is a "cancellation" signal that tells the UI and transcript to remove these messages.

---

## III. In-Depth Analysis of Streaming Processing

### 3.1 StreamingToolExecutor: Tools Execute While the API Is Still Streaming

StreamingToolExecutor is a tool executor with concurrency control. The core design is that **completed tool_use blocks begin execution immediately during API streaming output**, without waiting for the entire API response to finish.

#### Lifecycle: Two-Phase Execution

```
API 流式输出中:
  ├── 收到 tool_use block A -> streamingToolExecutor.addTool(A)
  │   └── processQueue() -> executeTool(A) 开始执行
  ├── 收到 tool_use block B -> addTool(B)
  │   └── processQueue() -> B 是否 concurrencySafe?
  │       ├── 是且 A 也是 -> 并行执行
  │       └── 否 -> 排队等待
  ├── 每次收到新 message -> getCompletedResults() 收割已完成结果
  │   └── yield 给消费者
  └── API 流结束

API 流结束后:
  └── getRemainingResults() — 等待所有剩余工具完成
      └── 异步 generator，用 Promise.race 等待
```

#### Concurrency Control Model

```typescript
// StreamingToolExecutor.ts:129-135
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

Rules:
- No tools currently executing -> any tool can execute
- Tools currently executing -> the new tool must be concurrencySafe, and all currently executing tools must also be concurrencySafe
- Non-concurrencySafe tools (such as Bash) require **exclusive** execution

This means multiple file reads can run in parallel, but Bash commands must run serially. This matches real-world scenarios: reading files has no side effects, but Bash commands may have implicit dependencies between them.

#### Error Propagation: Three-Layer Abort Signals

```typescript
// StreamingToolExecutor.ts:59-62
constructor(toolDefinitions, canUseTool, toolUseContext) {
  this.siblingAbortController = createChildAbortController(toolUseContext.abortController)
}

// 执行单个工具时:
const toolAbortController = createChildAbortController(this.siblingAbortController)
toolAbortController.signal.addEventListener('abort', () => {
  // Bash 错误 -> siblingAbort -> 所有兄弟工具取消
  // 但不向上传播到 query 的 abortController
  // 除非是权限拒绝等需要终止 turn 的情况
  if (toolAbortController.signal.reason !== 'sibling_error' &&
      !this.toolUseContext.abortController.signal.aborted &&
      !this.discarded) {
    this.toolUseContext.abortController.abort(toolAbortController.signal.reason)
  }
})
```

Hierarchy of the three-layer controllers:
```
queryLoop.abortController (用户中断 -> 终止整个 turn)
  └── siblingAbortController (Bash 错误 -> 取消同级工具，不终止 turn)
        └── toolAbortController (单个工具的控制器)
              └── 权限拒绝 -> abort 向上冒泡到 queryLoop
```

A regression (#21056) documented in the comments:

> `Permission-dialog rejection also aborts this controller ... Without bubble-up, ExitPlanMode "clear context + auto" sends REJECT_MESSAGE to the model instead of aborting`

Permission rejection must bubble up to the query level; otherwise the model receives a "rejected" message and continues execution instead of terminating the turn.

#### Real-Time Propagation of Progress Messages

```typescript
// StreamingToolExecutor.ts:367-375
if (update.message.type === 'progress') {
  tool.pendingProgress.push(update.message)
  // 唤醒 getRemainingResults 的等待
  if (this.progressAvailableResolve) {
    this.progressAvailableResolve()
    this.progressAvailableResolve = undefined
  }
} else {
  messages.push(update.message)  // 非 progress 消息按序缓冲
}
```

Progress messages (such as hook execution progress) need to be displayed in real time and cannot wait for tool completion. The design uses a resolve callback pattern: `getRemainingResults` awaits a Promise when there are no completed results or progress messages; when progress arrives, it resolves this Promise to wake up consumption.

### 3.2 How the yield Pipeline Propagates to Consumers

The entire streaming pipeline is a nesting of three AsyncGenerator layers:

```
queryLoop() ─yield→ query() ─yield*→ QueryEngine.submitMessage() ─yield→ SDK/REPL

层级:
  queryLoop: 产生 StreamEvent | Message | ToolUseSummaryMessage
  query:     yield* queryLoop (透传) + 命令生命周期通知
  submitMessage: 消费 query() 的输出，转换为 SDKMessage 格式
```

`query()` uses `yield*` delegation for `queryLoop()` (query.ts:230):

```typescript
const terminal = yield* queryLoop(params, consumedCommandUuids)
```

The semantics of `yield*` are: every yield from queryLoop is passed directly to query's consumer; query itself does not handle these intermediate values. Only the Terminal value returned by queryLoop is assigned to `terminal`.

submitMessage performs explicit consumption:

```typescript
for await (const message of query({...})) {
  switch (message.type) {
    case 'assistant': // -> mutableMessages.push + normalizeMessage -> yield SDKMessage
    case 'user':      // -> mutableMessages.push + normalizeMessage -> yield SDKMessage
    case 'stream_event': // -> 累计 usage，可选 yield partial
    case 'system':       // -> compact_boundary 处理，snipReplay
    case 'tombstone':    // -> 控制信号，不 yield
    // ...
  }
}
```

---

## IV. In-Depth Analysis of the 5-Layer Compaction Pipeline

### 4.1 Pipeline Execution Order and Mutual Exclusion Relationships

```
输入: messages (从 compact boundary 之后开始)
  │
  ▼
[L1] applyToolResultBudget()     ← 每条消息独立，按 tool_use_id 限制大小
  │   不与其他层互斥，总是运行
  ▼
[L2] snipCompactIfNeeded()       ← feature(HISTORY_SNIP)，裁剪老旧消息
  │   与 L3 不互斥（注释: "both may run — they are not mutually exclusive"）
  │   snipTokensFreed 传递给 L5 调整阈值
  ▼
[L3] microcompact()              ← 微压缩（缓存编辑优化）
  │   与 L2 compose cleanly：MC 用 tool_use_id，不看 content
  ▼
[L4] applyCollapsesIfNeeded()    ← feature(CONTEXT_COLLAPSE)，读时投影
  │   在 L5 之前运行 "so that if collapse gets us under the autocompact threshold,
  │   autocompact is a no-op and we keep granular context"
  ▼
[L5] autoCompactIfNeeded()       ← 自动压缩（用模型生成摘要）
  │   如果 L4 已经足够 -> no-op
  │   snipTokensFreed 参数修正阈值判断
  ▼
输出: 压缩后的 messagesForQuery
```

#### Key Design Trade-offs

**Reason for L4 before L5** (query.ts:430-438):

Context Collapse is a **lossless** operation (preserving fine-grained fold/unfold information), while Auto Compact is a **lossy** operation (generating summaries that lose detail). If collapse already brings the token count below the threshold, auto compact is unnecessary — preserving more recoverable context.

**Reason for L2's snipTokensFreed being passed to L5** (query.ts:397-399):

> `tokenCountWithEstimation alone can't see it (reads usage from the protected-tail assistant, which survives snip unchanged)`

Token estimation is based on API-returned usage (from the last assistant message), and snip does not modify this message, so the estimation is unaware that snip has already freed space. Manually passing snipTokensFreed prevents auto compact from misjudging "it's still too large."

### 4.2 Complex Conditions for Blocking Limit Checks

```typescript
// query.ts:615-648
if (
  !compactionResult &&                    // 刚压缩过就跳过（结果已验证）
  querySource !== 'compact' &&            // 压缩 agent 自身不能被阻塞（死锁）
  querySource !== 'session_memory' &&     // 同上
  !(reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()) &&
  !collapseOwnsIt                         // 同上理由
) {
  const { isAtBlockingLimit } = calculateTokenWarningState(
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
    toolUseContext.options.mainLoopModel,
  )
  if (isAtBlockingLimit) {
    yield createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE, ... })
    return { reason: 'blocking_limit' }
  }
}
```

The complexity of this condition reflects the tension between "prevention vs. reaction":
- If both reactive compact and auto compact are enabled, **preventive blocking is not performed** — let the API report 413 first, then handle it via reactive compact
- If context collapse is enabled and auto compact is also enabled, same logic applies
- But if the user explicitly disabled automatic mechanisms via `DISABLE_AUTO_COMPACT`, **preventive blocking is retained**

---

## V. Concurrency Safety: Abort Signal Propagation Across Three Generator Layers

### 5.1 Abort Checkpoints Across Three Generator Layers

```
queryLoop:
  [检查点 1] query.ts:1015 — API 流式完成后
  [检查点 2] query.ts:1485 — 工具执行完成后
  [检查点 3] stopHooks.ts:283 — stop hook 执行期间（每次迭代检查）

StreamingToolExecutor:
  [检查点 4] :278 — 工具开始执行前
  [检查点 5] :335 — 工具执行每次迭代

submitMessage (QueryEngine):
  [检查点 6] :972 — USD budget 检查时间接触发
```

### 5.2 Two Semantics of Interruption

```typescript
// query.ts:1046-1050
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  yield createUserInterruptionMessage({ toolUse: false })
}
```

- `reason === 'interrupt'`: The user entered a new message during tool execution (submit-interrupt). No interruption message is yielded because the new message itself provides context.
- `reason !== 'interrupt'` (typically ESC/Ctrl+C): The user explicitly interrupted; yield an interruption message to mark the position.

### 5.3 Usage Scenarios for discard()

StreamingToolExecutor's `discard()` is called in two scenarios:
1. **Streaming fallback**: The primary model's response is mid-stream when switching to the fallback model; previous tool executions must be discarded
2. **Fallback triggered error**: FallbackTriggeredError handling in the catch block

`discard()` sets `this.discarded = true`, after which:
- `getCompletedResults()` returns directly without yielding any results
- `getRemainingResults()` also returns directly
- In new `addTool()` calls, `getAbortReason()` returns `'streaming_fallback'`

---

## VI. Historical Stories in the Code

### 6.1 Bug Fix Records

**StreamingToolExecutor's #21056 regression**:

```typescript
// StreamingToolExecutor.ts:296-318
// Permission-dialog rejection also aborts this controller (PermissionContext.ts cancelAndAbort) —
// that abort must bubble up to the query controller so the query loop's post-tool abort check
// ends the turn. Without bubble-up, ExitPlanMode "clear context + auto" sends REJECT_MESSAGE
// to the model instead of aborting (#21056 regression).
```

**Reactive compact infinite loop**:

```typescript
// query.ts:1292-1296
// Preserve the reactive compact guard — if compact already ran and couldn't recover
// from prompt-too-long, retrying after a stop-hook blocking error will produce the same result.
// Resetting to false here caused an infinite loop:
// compact -> still too long -> error -> stop hook blocking -> compact -> ...
```

**Transcript loss causing --resume failure**:

```typescript
// QueryEngine.ts:440-449
// If the process is killed before that (e.g. user clicks Stop in cowork seconds after send),
// the transcript is left with only queue-operation entries; getLastSessionLog filters those out,
// returns null, and --resume fails with "No conversation found".
// Writing now makes the transcript resumable from the point the user message was accepted.
```

### 6.2 Performance Optimization Records

**Memory optimization for dumpPromptsFetch**:

```typescript
// query.ts:583-590
// Each call to createDumpPromptsFetch creates a closure that captures the request body.
// Creating it once means only the latest request body is retained (~700KB),
// instead of all request bodies from the session (~500MB for long sessions).
```

**GC release after compact boundary**:

```typescript
// QueryEngine.ts:926-933
const mutableBoundaryIdx = this.mutableMessages.length - 1
if (mutableBoundaryIdx > 0) {
  this.mutableMessages.splice(0, mutableBoundaryIdx)  // 释放旧消息的引用
}
```

**Fire-and-forget transcript for assistant messages**:

```typescript
// QueryEngine.ts:719-727
// Awaiting here blocks ask()'s generator, so message_delta can't run until
// every block is consumed; the drain timer (started at block 1) elapses first.
// enqueueWrite is order-preserving so fire-and-forget here is safe.
if (message.type === 'assistant') {
  void recordTranscript(messages)  // 不 await，不阻塞流式
} else {
  await recordTranscript(messages)
}
```

### 6.3 Defensive Comments

**The "Wizard's Parable" for thinking rules**:

```typescript
// query.ts:152-163
// The rules of thinking are lengthy and fortuitous. They require plenty of thinking
// of most long duration and deep meditation for a wizard to wrap one's noggin around.
// ...
// Heed these rules well, young wizard. For they are the rules of thinking, and
// the rules of thinking are the rules of the universe. If ye does not heed these
// rules, ye will be punished with an entire day of debugging and hair pulling.
```

Behind this humorous comment lies a serious problem: the API has strict constraints on thinking block placement and lifecycle. Violations cause 400 errors, and these rules are extremely easy to break during multi-turn conversations and compaction interactions.

---

## VII. Design Philosophy: Why while(tool_call) Is Better Than DAG/ReAct/Plan-Execute

### 7.1 Comparison with Other Paradigms

| Dimension | Claude Code (while loop) | DAG (LangGraph) | ReAct | Plan-Execute |
|---|---|---|---|---|
| Control Flow | Imperative, 7 explicit continues | Declarative, graph edges | Prompt-driven | Two-phase separation |
| Error Recovery | Dedicated recovery path for each error type | Requires modeling error nodes in the graph | No built-in recovery | Planner needs to re-plan |
| Context Management | 5-layer compaction pipeline | Developer handles it themselves | None | None |
| Streaming | Native AsyncGenerator | Requires additional adaptation | Typically non-streaming | Typically non-streaming |
| Testability | transition.reason is assertable | Graph paths are testable | Difficult to test | Moderate |

### 7.2 Core Advantages of the while Loop

**1. Determinism**: The 7 continue sites form a finite state machine with fully explicit preconditions for each path. In DAG frameworks, conditional edges between nodes often require runtime evaluation, and the combinatorial explosion of paths makes exhaustive coverage difficult.

**2. Precision of error recovery**: Each error type has an independent recovery strategy, and the degradation path after recovery failure is also deterministic. Expressing "first try collapse drain, if that fails try reactive compact, if that also fails expose the error" in a DAG requires 3 nodes + conditional edges + shared state — far more complex than writing if-else directly.

**3. Centralized context management**: The 5-layer compaction pipeline executes uniformly at the loop entry, ensuring every API call undergoes complete context optimization. In a DAG, this would require mounting compaction logic on the incoming edges of every "call API" node, or introducing a dedicated "compaction node" with global routing.

**4. Natural streaming**: AsyncGenerator's yield is inherently suited for streaming scenarios — each content block can be delivered to consumers in real time. DAG frameworks typically require nodes to complete execution before producing output, or need an additional streaming adaptation layer.

**5. Debuggability**: `transition.reason` is a simple string tag, making logging, breakpoints, and test assertions intuitive. Understanding execution paths in a DAG requires graph tracing.

### 7.3 The Cost of This Design

**1. Complex conditional nesting**: The 1729-line queryLoop function with 7 continue sites distributed across different nesting levels requires strong context memory to read.

**2. Manual State object management**: Each continue site must construct a complete State object, making it easy to overlook field resets or preservations (the `hasAttemptedReactiveCompact` bug is a prime example).

**3. Test fragility**: Although `transition.reason` is assertable, testing a specific continue path requires carefully constructing conditions that trigger it — typically a combination of mocks and feature gate configurations.

The `deps.ts` and `config.ts` mentioned in the comments were introduced precisely to mitigate testing issues:

```typescript
// query/deps.ts:8-12
// Passing a `deps` override into QueryParams lets tests inject fakes directly
// instead of spyOn-per-module — the most common mocks (callModel, autocompact)
// are each spied in 6-8 test files today with module-import-and-spy boilerplate.
```

```typescript
// query/config.ts:8-14
// Separating these from the per-iteration State struct and the mutable ToolUseContext
// makes future step() extraction tractable — a pure reducer can take (state, event, config)
// where config is plain data.
```

This reveals the team's long-term vision: refactoring queryLoop into a pure function reducer `step(state, event, config) -> (state, effects)`, eliminating the complexity of the while loop while preserving the advantages of the deterministic state machine.

---

## VIII. Patterns Worth Learning

### 8.1 Withhold-then-Decide

Applicable scenarios: Any streaming system that needs to "attempt recovery first, and only expose the error if recovery fails." Key implementation points:

- Withheld messages must still be pushed to an internal array (recovery logic needs to find them)
- Withhold and recover must see the same feature gate value (hoist strategy)
- Recovery success = continue (swallow the error), recovery failure = yield (expose the error)

### 8.2 Full State Replacement

Applicable scenarios: Any loop with multiple continue/break paths. Benefits:

- The intent of each path is immediately clear
- "Forgetting to reset a variable" bugs are impossible (because the complete State must be constructed)
- `transition.reason` provides free observability

### 8.3 Three-Layer AbortController Hierarchy

Applicable scenarios: Concurrent tool/task execution requiring different granularity levels of cancellation control. Design principles:

- Sibling errors only cancel siblings (siblingAbortController), without affecting the parent
- But permission rejection needs to bubble up to the parent (toolAbortController -> queryLoop)
- `discard()` as a last resort, discarding all pending results in one action

### 8.4 Feature Gate Tree-Shaking Constraints

Applicable scenarios: Products that need to eliminate code at compile time. Core rule:

```typescript
// 正确：feature() 在 if 条件中
if (feature('HISTORY_SNIP')) { ... }

// 错误：feature() 赋值给变量
const hasSnip = feature('HISTORY_SNIP')  // bun:bundle 无法 tree-shake
if (hasSnip) { ... }
```

This explains the numerous seemingly redundant nested if-statements in the code — they are not a style issue, but a compiler constraint.

### 8.5 Token Budget Diminishing Returns Detection

```typescript
// tokenBudget.ts:59-63
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < DIMINISHING_THRESHOLD &&   // 500 tokens
  tracker.lastDeltaTokens < DIMINISHING_THRESHOLD
```

Two consecutive outputs below 500 tokens, with at least 3 continuations already -> considered diminishing returns, stopping early. This prevents the model from falling into an "inefficient loop" when substantial budget remains (repeatedly outputting small amounts of tokens and then being nudged to continue).

---

## IX. Complete Architecture of Stop Hooks

### 9.1 Execution Order of Three Hook Types

`handleStopHooks()` (stopHooks.ts:65-473) is an AsyncGenerator that executes in the following order:

```
1. 背景任务 (fire-and-forget):
   - Template job classification (classifyAndWriteState)
   - Prompt suggestion (executePromptSuggestion)
   - Memory extraction (executeExtractMemories)
   - Auto dream (executeAutoDream)
   - Computer Use cleanup (cleanupComputerUseAfterTurn)

2. Stop hooks (阻塞):
   - executeStopHooks() -> 产生 progress/attachment/blockingError
   - 收集 hookErrors, hookInfos, preventContinuation
   - 生成 summary message

3. Teammate hooks (仅在 teammate 模式):
   - TaskCompleted hooks (对每个 in_progress 任务)
   - TeammateIdle hooks
```

### 9.2 Safety Design of Background Tasks

```typescript
// stopHooks.ts:136-157
if (!isBareMode()) {
  // Prompt suggestion: fire-and-forget
  void executePromptSuggestion(stopHookContext)

  // Memory extraction: fire-and-forget, 但不在 subagent 中运行
  if (feature('EXTRACT_MEMORIES') && !toolUseContext.agentId && isExtractModeActive()) {
    void extractMemoriesModule!.executeExtractMemories(...)
  }

  // Auto dream: 同样不在 subagent 中
  if (!toolUseContext.agentId) {
    void executeAutoDream(...)
  }
}
```

All background tasks have the `!toolUseContext.agentId` guard — subagents should not trigger these global side effects. The `isBareMode()` guard ensures that `-p` mode (scripted invocation) does not start unnecessary background processes.

### 9.3 Snapshot Timing of CacheSafeParams

```typescript
// stopHooks.ts:96-98
if (querySource === 'repl_main_thread' || querySource === 'sdk') {
  saveCacheSafeParams(createCacheSafeParams(stopHookContext))
}
```

This snapshot is saved before stop hooks execute, for use by the `/btw` command and SDK side_question. The comments emphasize "Outside the prompt-suggestion gate" — this snapshot still needs to be saved even if the prompt suggestion feature is disabled.

---

## X. Related File Index

| File | Lines | Responsibility |
|---|---|---|
| `src/QueryEngine.ts` | ~1295 | Session manager, SDK interface, cross-turn state persistence |
| `src/query.ts` | ~1729 | Core while loop, 7 continue sites, 5-layer compaction pipeline |
| `src/query/config.ts` | ~47 | Immutable query configuration snapshot (session ID, feature gates) |
| `src/query/deps.ts` | ~40 | Dependency injection (callModel, compact, uuid) |
| `src/query/stopHooks.ts` | ~474 | Stop/TaskCompleted/TeammateIdle hooks + background task triggering |
| `src/query/tokenBudget.ts` | ~94 | Token budget tracking and diminishing returns detection |
| `src/services/tools/StreamingToolExecutor.ts` | ~531 | Streaming tool executor, concurrency control, three-layer abort |
