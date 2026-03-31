# 01 - Agent Loop 核心循环：深度架构分析

## 概述

Claude Code 的 Agent Loop 是一个基于 AsyncGenerator 的多层嵌套循环架构，负责管理"用户输入 -> 模型推理 -> 工具执行 -> 结果回送"的完整生命周期。核心由三层组成：

1. **QueryEngine**（`QueryEngine.ts`, ~1295 行）：会话级别的管理器，拥有消息历史、使用量统计、权限追踪等状态。每次 `submitMessage()` 开启一个新回合（turn）。
2. **query() / queryLoop()**（`query.ts`, ~1729 行）：单次回合的核心 `while(true)` 循环，负责反复调用模型 API、执行工具、处理错误恢复，直到模型不再请求工具调用。
3. **辅助模块**（`query/` 目录）：配置快照 (`config.ts`)、依赖注入 (`deps.ts`)、停止钩子 (`stopHooks.ts`)、Token 预算 (`tokenBudget.ts`)。

**关键设计哲学**：整个架构使用 `AsyncGenerator` + `yield*` 委托，实现了惰性求值的流式管道。每一层都能 yield 消息给调用者（SDK/REPL），同时保持自身状态机的运转。这不是一个 DAG、不是 ReAct 框架、也不是 Plan-Execute 体系——它是一个精心设计的命令式状态机，通过 7 个显式 `continue` 站点构成确定性的状态转移。

---

## 一、queryLoop 完整状态机还原

### 1.1 State 结构：循环的全部记忆

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

关键设计：State 使用**全量替换**而非部分赋值。每个 `continue` 站点都创建一个完整的新 State 对象赋给 `state`。这带来三个好处：(1) 状态变迁的原子性——不会出现赋值到一半被中断的脏状态；(2) 每个 continue 路径的意图清晰可审计——看 State 构造就知道哪些字段被重置、哪些被保留；(3) `transition.reason` 字段让测试能断言走了哪条恢复路径。

### 1.2 完整状态机图

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

### 1.3 七个 Continue 站点的精确触发条件与状态转移

| # | transition.reason | 触发条件 | 关键状态变化 | 代码位置 |
|---|---|---|---|---|
| 1 | `collapse_drain_retry` | PTL 413 错误 + CONTEXT_COLLAPSE 启用 + 上次不是 collapse_drain + drain committed > 0 | messages 替换为 drained.messages；保留 hasAttemptedReactiveCompact | ~1099-1115 |
| 2 | `reactive_compact_retry` | (PTL 413 或 media_size_error) + reactiveCompact 成功 | messages 替换为 postCompactMessages；hasAttemptedReactiveCompact 设为 true | ~1152-1165 |
| 3 | `max_output_tokens_escalate` | MOT 错误 + capEnabled + 之前没有 override + 无环境变量覆盖 | maxOutputTokensOverride 设为 ESCALATED_MAX_TOKENS (64k) | ~1207-1221 |
| 4 | `max_output_tokens_recovery` | MOT 错误 + recoveryCount < 3 (escalate 已用或不可用) | messages 追加 assistant + recovery meta；recoveryCount++ | ~1231-1252 |
| 5 | `stop_hook_blocking` | stop hook 返回 blockingErrors | messages 追加 assistant + blockingErrors；保留 hasAttemptedReactiveCompact | ~1283-1306 |
| 6 | `token_budget_continuation` | TOKEN_BUDGET 启用 + budget 未达 90% + 非 diminishing returns | messages 追加 assistant + nudge；重置 MOT recovery 和 reactiveCompact | ~1321-1341 |
| 7 | `next_turn` | 工具执行完毕，准备下一轮 | messages = forQuery + assistant + toolResults；turnCount++；重置 MOT 和 reactive 状态 | ~1715-1727 |

**互斥与优先级关系**：

Continue 1-6 都在 `!needsFollowUp` 分支内（模型没有请求工具调用），它们的优先级是**瀑布式**的：

```
PTL 413? ──Yes──> 尝试 collapse drain [1]
                      │ drain 无效
                      ▼
                  尝试 reactive compact [2]
                      │ compact 失败
                      ▼
                  surface error + return

MOT? ──Yes──> 尝试 escalate [3]
                  │ 已 escalate 或不可用
                  ▼
              尝试 multi-turn recovery [4] (最多3次)
                  │ 恢复次数耗尽
                  ▼
              surface error (yield lastMessage)

isApiErrorMessage? ──Yes──> return (跳过 stop hooks，防死循环)

stop hooks ──blocking──> [5] stop_hook_blocking (注入错误让模型修正)
           ──prevent──> return (直接终止)

token budget ──continue──> [6] token_budget_continuation
             ──stop──> return completed
```

Continue 7 (`next_turn`) 在 `needsFollowUp === true` 的分支末尾，与 1-6 互斥——模型要么请求了工具调用（走 7），要么没有（走 1-6 中的某一个或 return）。

### 1.4 关键防御机制：hasAttemptedReactiveCompact 的跨站点守卫

这个布尔值的管理揭示了一个精巧的防死循环设计：

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

这意味着：如果 reactive compact 已经尝试过了，stop hook 触发重试时不会再尝试压缩。但如果经过了一轮完整的工具调用（模型可能已经自行处理了上下文），则允许再次尝试。

---

## 二、错误处理逐层分析

### 2.1 "Withhold-then-Decide" 模式的完整实现

这是 Agent Loop 最精妙的错误处理模式。核心思想：**可恢复的错误消息不立即暴露给消费者，而是先暂扣，等恢复逻辑运行后再决定是丢弃（恢复成功）还是暴露（恢复失败）**。

#### 为什么需要 Withhold？

注释道出了动机（query.ts:166-171）：

```
Yielding early leaks an intermediate error to SDK callers (e.g. cowork/desktop)
that terminate the session on any `error` field — the recovery loop keeps running
but nobody is listening.
```

SDK 消费者（如 Desktop 桌面端）会在收到任何 error 字段时终止会话。如果在恢复成功之前就 yield 了错误，消费者断开了，恢复循环还在白白运行——典型的"生产者消费者脱节"。

#### Withhold 的四类目标

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

#### 恢复与暴露的决策点

流式循环结束后，如果 `needsFollowUp === false`：

```
withheld PTL?
  ├── collapse drain 成功 -> continue [1] (错误被吞掉)
  ├── reactive compact 成功 -> continue [2] (错误被吞掉)
  └── 都失败 -> yield lastMessage (错误暴露) + return

withheld MOT?
  ├── escalate -> continue [3] (错误被吞掉)
  ├── multi-turn recovery -> continue [4] (错误被吞掉)
  └── 恢复耗尽 -> yield lastMessage (错误暴露)

withheld media?
  ├── reactive compact 成功 -> continue [2]
  └── 失败 -> yield lastMessage + return
```

#### mediaRecoveryEnabled 的 hoist 策略

```typescript
// query.ts:625-627
const mediaRecoveryEnabled = reactiveCompact?.isReactiveCompactEnabled() ?? false
```

注释说明了为什么要在循环入口处 hoist 这个值：

> `CACHED_MAY_BE_STALE can flip during the 5-30s stream, and withhold-without-recover would eat the message.`

如果在 withhold 时检测到应该暂扣（gate 打开），但在恢复时 gate 关闭了，消息就永远被"吃掉"了——用户既看不到错误，也看不到恢复。Hoist 确保 withhold 和 recover 看到的是同一个值。

### 2.2 Prompt-Too-Long (PTL) 的完整恢复路径

PTL 是 Agent 最常遇到的错误——长对话不可避免地会突破上下文窗口。恢复路径是三级递进：

**第一级：Context Collapse Drain**

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

Context Collapse 在正常流程中是"暂存折叠"——标记哪些消息可以被折叠但还没有执行。PTL 时触发 drain：立即提交所有暂存的折叠。`state.transition?.reason !== 'collapse_drain_retry'` 防止连续 drain 两次——如果 drain 后重试仍然 PTL，就放弃这个路径。

**第二级：Reactive Compact**

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

Reactive Compact 是一个完整的压缩操作（用模型生成摘要），比 drain 更重但更彻底。`hasAttempted` 守卫确保只尝试一次。

**第三级：暴露错误**

```typescript
// query.ts:1172-1183
yield lastMessage  // 把暂扣的 PTL 错误暴露给消费者
void executeStopFailureHooks(lastMessage, toolUseContext)
return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
```

注释特别强调了**不走 stop hooks 的原因**：

> `Running stop hooks on prompt-too-long creates a death spiral: error -> hook blocking -> retry -> error -> ...`
> (hook 注入更多 tokens -> 上下文更大 -> 更容易 PTL -> 无限循环)

### 2.3 Max Output Tokens (MOT) 的恢复路径

MOT 的恢复比 PTL 更复杂，因为它有两阶段：

**阶段 1：Escalation（升级上限）**

```typescript
// query.ts:1195-1221
const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
if (capEnabled && maxOutputTokensOverride === undefined && !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  logEvent('tengu_max_tokens_escalate', { escalatedTo: ESCALATED_MAX_TOKENS })
  // continue [3]: max_output_tokens_escalate
  // maxOutputTokensOverride 设为 ESCALATED_MAX_TOKENS (64k)
}
```

设计细节：
- `maxOutputTokensOverride === undefined` 确保只 escalate 一次
- `!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` 尊重用户的显式配置
- 注释说明 `3P default: false (not validated on Bedrock/Vertex)` ——第三方提供商不启用

**阶段 2：Multi-turn Recovery（多轮恢复）**

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

这条 recovery 消息的措辞精心设计：
- "no apology, no recap"——防止模型浪费 token 重复上文
- "Pick up mid-thought"——处理输出在句子中间被截断的情况
- "Break remaining work into smaller pieces"——引导模型自适应缩小输出粒度
- `isMeta: true`——对 UI 不可见，是纯粹的控制信号

### 2.4 Fallback 模型切换的完整流程

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

Tombstone 机制值得关注：fallback 时已经流式输出了部分 assistant 消息（包括 thinking blocks），这些消息的 thinking signatures 是与原模型绑定的。如果不清除，replay 给新模型会 400 错误 ("thinking blocks cannot be modified")。Tombstone 是一个"取消"信号，告诉 UI 和 transcript 删除这些消息。

---

## 三、流式处理深度分析

### 3.1 StreamingToolExecutor：API 还在流，工具先执行

StreamingToolExecutor 是一个带并发控制的工具执行器，核心设计是**在 API 流式输出的同时，已完成的 tool_use block 立即开始执行**，不必等待整个 API 响应结束。

#### 生命周期：两阶段执行

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

#### 并发控制模型

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

规则：
- 没有正在执行的工具 -> 任何工具都可以执行
- 有正在执行的工具 -> 新工具必须是 concurrencySafe，且所有正在执行的也必须是 concurrencySafe
- 非 concurrencySafe 工具（如 Bash）需要**独占**执行

这意味着多个 Read 文件可以并行，但 Bash 命令必须串行。这与实际场景匹配：读文件是无副作用的，但 Bash 命令之间可能有隐式依赖。

#### 错误传播：三层 abort 信号

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

三层控制器的层次关系：
```
queryLoop.abortController (用户中断 -> 终止整个 turn)
  └── siblingAbortController (Bash 错误 -> 取消同级工具，不终止 turn)
        └── toolAbortController (单个工具的控制器)
              └── 权限拒绝 -> abort 向上冒泡到 queryLoop
```

注释中记录了一个 regression (#21056)：

> `Permission-dialog rejection also aborts this controller ... Without bubble-up, ExitPlanMode "clear context + auto" sends REJECT_MESSAGE to the model instead of aborting`

权限拒绝必须冒泡到 query 层级，否则模型会收到一个 "rejected" 消息然后继续执行，而不是终止 turn。

#### Progress 消息的实时传播

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

Progress 消息（如 hook 执行进度）需要实时展示，不能等工具完成。设计用了一个 resolve callback 模式：`getRemainingResults` 在没有完成结果和 progress 时 await 一个 Promise，progress 到来时 resolve 这个 Promise 唤醒消费。

### 3.2 yield 管道如何传播到消费者

整个流式管道是三层 AsyncGenerator 的嵌套：

```
queryLoop() ─yield→ query() ─yield*→ QueryEngine.submitMessage() ─yield→ SDK/REPL

层级:
  queryLoop: 产生 StreamEvent | Message | ToolUseSummaryMessage
  query:     yield* queryLoop (透传) + 命令生命周期通知
  submitMessage: 消费 query() 的输出，转换为 SDKMessage 格式
```

`query()` 对 `queryLoop()` 使用 `yield*` 委托（query.ts:230）：

```typescript
const terminal = yield* queryLoop(params, consumedCommandUuids)
```

`yield*` 的语义是：queryLoop 的每次 yield 都直接传递给 query 的消费者，query 本身不处理这些中间值。只有 queryLoop return 的 Terminal 值被赋给 `terminal`。

submitMessage 则是显式消费：

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

## 四、5 层压缩管线深度分析

### 4.1 管线执行顺序与互斥关系

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

#### 关键设计权衡

**L4 在 L5 之前**的原因（query.ts:430-438）：

Context Collapse 是一种**无损**操作（保留细粒度的 fold/unfold 信息），而 Auto Compact 是**有损**操作（生成摘要丢失细节）。如果 collapse 已经把 token 数降到阈值以下，就不需要 auto compact——保留了更多可还原的上下文。

**L2 的 snipTokensFreed 传递给 L5**的原因（query.ts:397-399）：

> `tokenCountWithEstimation alone can't see it (reads usage from the protected-tail assistant, which survives snip unchanged)`

Token 估算基于 API 返回的 usage（来自最后一条 assistant 消息），snip 不会修改这条消息，所以估算不知道 snip 已经释放了空间。手动传递 snipTokensFreed 让 auto compact 不会误判"还是太大了"。

### 4.2 阻塞限制检查的复杂条件

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

这个条件的复杂性反映了"预防 vs 反应"的张力：
- 如果 reactive compact 和 auto compact 都启用，**不做预防性阻塞**——让 API 先报 413，再由 reactive compact 处理
- 如果 context collapse 启用且 auto compact 也启用，同理
- 但如果用户通过 `DISABLE_AUTO_COMPACT` 显式关闭了自动机制，则**保留预防性阻塞**

---

## 五、并发安全：abort 信号在三层 generator 间的传播

### 5.1 三层 generator 的 abort 检查点

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

### 5.2 中断的两种语义

```typescript
// query.ts:1046-1050
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  yield createUserInterruptionMessage({ toolUse: false })
}
```

- `reason === 'interrupt'`：用户在工具执行期间输入了新消息（submit-interrupt）。此时不 yield 中断消息，因为新消息本身就是上下文。
- `reason !== 'interrupt'`（通常是 ESC/Ctrl+C）：用户显式中断，yield 中断消息标记位置。

### 5.3 discard() 的使用场景

StreamingToolExecutor 的 `discard()` 在两个场景被调用：
1. **streaming fallback**：主模型响应到一半切换到备选模型，之前的工具执行必须丢弃
2. **fallback triggered error**：catch 块中的 FallbackTriggeredError 处理

`discard()` 设置 `this.discarded = true`，之后：
- `getCompletedResults()` 直接 return，不 yield 任何结果
- `getRemainingResults()` 同样直接 return
- 新的 `addTool()` 调用中，`getAbortReason()` 返回 `'streaming_fallback'`

---

## 六、代码中的历史故事

### 6.1 Bug 修复记录

**StreamingToolExecutor 的 #21056 regression**：

```typescript
// StreamingToolExecutor.ts:296-318
// Permission-dialog rejection also aborts this controller (PermissionContext.ts cancelAndAbort) —
// that abort must bubble up to the query controller so the query loop's post-tool abort check
// ends the turn. Without bubble-up, ExitPlanMode "clear context + auto" sends REJECT_MESSAGE
// to the model instead of aborting (#21056 regression).
```

**Reactive compact 无限循环**：

```typescript
// query.ts:1292-1296
// Preserve the reactive compact guard — if compact already ran and couldn't recover
// from prompt-too-long, retrying after a stop-hook blocking error will produce the same result.
// Resetting to false here caused an infinite loop:
// compact -> still too long -> error -> stop hook blocking -> compact -> ...
```

**Transcript 丢失导致 --resume 失败**：

```typescript
// QueryEngine.ts:440-449
// If the process is killed before that (e.g. user clicks Stop in cowork seconds after send),
// the transcript is left with only queue-operation entries; getLastSessionLog filters those out,
// returns null, and --resume fails with "No conversation found".
// Writing now makes the transcript resumable from the point the user message was accepted.
```

### 6.2 性能优化记录

**dumpPromptsFetch 的内存优化**：

```typescript
// query.ts:583-590
// Each call to createDumpPromptsFetch creates a closure that captures the request body.
// Creating it once means only the latest request body is retained (~700KB),
// instead of all request bodies from the session (~500MB for long sessions).
```

**compact boundary 后的 GC 释放**：

```typescript
// QueryEngine.ts:926-933
const mutableBoundaryIdx = this.mutableMessages.length - 1
if (mutableBoundaryIdx > 0) {
  this.mutableMessages.splice(0, mutableBoundaryIdx)  // 释放旧消息的引用
}
```

**Assistant message 的 fire-and-forget transcript**：

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

### 6.3 防御性注释

**Thinking 规则的"巫师寓言"**：

```typescript
// query.ts:152-163
// The rules of thinking are lengthy and fortuitous. They require plenty of thinking
// of most long duration and deep meditation for a wizard to wrap one's noggin around.
// ...
// Heed these rules well, young wizard. For they are the rules of thinking, and
// the rules of thinking are the rules of the universe. If ye does not heed these
// rules, ye will be punished with an entire day of debugging and hair pulling.
```

这段幽默的注释背后是一个严肃的问题：API 对 thinking block 有严格的位置和生命周期约束，违反会导致 400 错误，而这些规则在多轮对话和压缩交互中极其容易被破坏。

---

## 七、设计哲学：为什么 while(tool_call) 比 DAG/ReAct/Plan-Execute 更好？

### 7.1 与其他范式的对比

| 维度 | Claude Code (while 循环) | DAG (LangGraph) | ReAct | Plan-Execute |
|---|---|---|---|---|
| 控制流 | 命令式，7 个显式 continue | 声明式，图的边 | prompt 驱动 | 两阶段分离 |
| 错误恢复 | 每种错误有专门的恢复路径 | 需要在图中建模错误节点 | 无内建恢复 | planner 需要重新规划 |
| 上下文管理 | 5 层压缩管线 | 开发者自行处理 | 无 | 无 |
| 流式 | 原生 AsyncGenerator | 需要额外适配 | 通常非流式 | 通常非流式 |
| 可测试性 | transition.reason 可断言 | 图的路径可测试 | 难以测试 | 中等 |

### 7.2 while 循环的核心优势

**1. 确定性**：7 个 continue 站点形成有限状态机，每条路径的前置条件完全明确。DAG 框架中，节点之间的条件边往往需要运行时 evaluation，路径组合爆炸难以穷举。

**2. 错误恢复的精度**：每种错误类型有独立的恢复策略，恢复失败后的降级路径也是确定的。在 DAG 中表达"先试 collapse drain，失败了试 reactive compact，再失败暴露错误"需要 3 个节点 + 条件边 + 共享状态——比直接写 if-else 复杂得多。

**3. 上下文管理的集中性**：5 层压缩管线在循环入口统一执行，确保每次 API 调用都经过完整的上下文优化。DAG 中这需要在每个"调用 API"节点的入边上都挂载压缩逻辑，或者引入一个专门的"压缩节点"然后全局路由。

**4. 流式的自然性**：AsyncGenerator 的 yield 天然适配流式场景——每个 content block 都能实时传递给消费者。DAG 框架通常需要节点执行完毕后才能产出，或者需要额外的流式适配层。

**5. 可调试性**：`transition.reason` 是一个简单的 string tag，log/断点/test assertion 都很直观。DAG 的执行路径需要通过图的 trace 才能理解。

### 7.3 这个设计的代价

**1. 复杂的条件嵌套**：1729 行的 queryLoop 函数，7 个 continue 站点分布在不同的嵌套层级中，阅读需要很强的上下文记忆。

**2. State 对象的手动管理**：每个 continue 站点都要构造完整的 State 对象，容易遗漏字段的重置/保留（`hasAttemptedReactiveCompact` 的 bug 就是例证）。

**3. 测试的脆弱性**：虽然 `transition.reason` 可断言，但要测试某个特定的 continue 路径，需要精心构造能触发它的条件——通常是一系列 mock 和 feature gate 的组合。

注释中的 `deps.ts` 和 `config.ts` 正是为了缓解测试问题而引入的：

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

这揭示了团队的长期愿景：将 queryLoop 重构为 `step(state, event, config) -> (state, effects)` 的纯函数 reducer，消除 while 循环的复杂性，同时保留确定性状态机的优势。

---

## 八、值得学习的模式

### 8.1 Withhold-then-Decide

适用场景：任何需要"先尝试恢复，恢复失败再暴露错误"的流式系统。关键实现要点：

- 暂扣的消息仍然要 push 到内部数组（恢复逻辑要能找到它）
- Withhold 和 recover 必须看到同一个 feature gate 值（hoist 策略）
- 恢复成功 = continue（吞掉错误），恢复失败 = yield（暴露错误）

### 8.2 状态全量替换

适用场景：任何有多个 continue/break 路径的循环。好处：

- 每个路径的意图一目了然
- 不可能出现"忘了重置某个变量"的 bug（因为必须构造完整 State）
- `transition.reason` 提供免费的可观测性

### 8.3 三层 AbortController 层次

适用场景：并发工具/任务执行中需要不同粒度的取消控制。设计原则：

- 同级错误只取消同级（siblingAbortController），不影响上级
- 但权限拒绝需要冒泡到上级（toolAbortController -> queryLoop）
- `discard()` 作为最终手段，一键丢弃所有待处理结果

### 8.4 Feature Gate 的 Tree-Shaking 约束

适用场景：需要在编译时消除代码的产品。核心规则：

```typescript
// 正确：feature() 在 if 条件中
if (feature('HISTORY_SNIP')) { ... }

// 错误：feature() 赋值给变量
const hasSnip = feature('HISTORY_SNIP')  // bun:bundle 无法 tree-shake
if (hasSnip) { ... }
```

这解释了代码中大量看似冗余的嵌套 if——它们不是风格问题，是编译器的约束。

### 8.5 Token Budget 的 Diminishing Returns 检测

```typescript
// tokenBudget.ts:59-63
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < DIMINISHING_THRESHOLD &&   // 500 tokens
  tracker.lastDeltaTokens < DIMINISHING_THRESHOLD
```

连续两次产出低于 500 tokens，且已经继续了至少 3 次 -> 视为 diminishing returns，提前停止。这避免了模型在 budget 还剩很多时陷入"低效循环"（反复输出少量 token 然后被 nudge 继续）。

---

## 九、Stop Hooks 的完整架构

### 9.1 三类 Hook 的执行顺序

`handleStopHooks()` (stopHooks.ts:65-473) 是一个 AsyncGenerator，按以下顺序执行：

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

### 9.2 背景任务的安全设计

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

所有背景任务都有 `!toolUseContext.agentId` 守卫——subagent（子代理）不应该触发这些全局副作用。`isBareMode()` 守卫确保 `-p` 模式（脚本化调用）不会启动不必要的后台进程。

### 9.3 CacheSafeParams 的快照时机

```typescript
// stopHooks.ts:96-98
if (querySource === 'repl_main_thread' || querySource === 'sdk') {
  saveCacheSafeParams(createCacheSafeParams(stopHookContext))
}
```

这个快照在 stop hooks 之前保存，供 `/btw` 命令和 SDK side_question 使用。注释强调"Outside the prompt-suggestion gate"——即使 prompt suggestion 功能关闭，这个快照仍然需要保存。

---

## 十、相关文件索引

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/QueryEngine.ts` | ~1295 | 会话管理器，SDK 接口，跨 turn 状态持久化 |
| `src/query.ts` | ~1729 | 核心 while 循环，7 个 continue 站点，5 层压缩管线 |
| `src/query/config.ts` | ~47 | 不可变查询配置快照（session ID, feature gates） |
| `src/query/deps.ts` | ~40 | 依赖注入（callModel, compact, uuid）|
| `src/query/stopHooks.ts` | ~474 | Stop/TaskCompleted/TeammateIdle 钩子 + 背景任务触发 |
| `src/query/tokenBudget.ts` | ~94 | Token 预算追踪与 diminishing returns 检测 |
| `src/services/tools/StreamingToolExecutor.ts` | ~531 | 流式工具执行器，并发控制，三层 abort |
