# 05 - 上下文管理与压缩系统 (深度分析)

## 一、系统架构总览

Claude Code 的上下文管理是一个精密的多层系统，核心矛盾在于：长编程会话的信息量远超模型上下文窗口（默认 200K tokens，最高 1M tokens），必须在"信息完整性"和"窗口有限性"之间动态平衡。系统采用三层压缩架构——微压缩(Microcompact) -> 会话记忆压缩(Session Memory Compact) -> 全量压缩(Full Compact)——每层都有独立的触发条件、实现策略和信息保留策略。

---

## 二、Token 计数的精确实现

### 2.1 `tokenCountWithEstimation()` -- 核心度量函数

这是系统判断上下文使用量的**唯一权威入口**，所有阈值判断（自动压缩、会话记忆初始化等）都使用它。其算法是"API 精确值 + 粗算增量"的混合策略：

```typescript
// utils/tokens.ts
export function tokenCountWithEstimation(messages: readonly Message[]): number {
  // 从消息尾部向前搜索最后一条有 usage 数据的 assistant 消息
  let i = messages.length - 1
  while (i >= 0) {
    const usage = getTokenUsage(messages[i])
    if (usage) {
      // 关键：处理并行 tool call 回溯
      const responseId = getAssistantMessageId(messages[i])
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const priorId = getAssistantMessageId(messages[j])
          if (priorId === responseId) i = j      // 同一 API 响应的更早拆分记录
          else if (priorId !== undefined) break   // 遇到不同 API 响应，停止
          j--
        }
      }
      // 精确值 + 后续新增消息的粗算
      return getTokenCountFromUsage(usage) + roughTokenCountEstimationForMessages(messages.slice(i + 1))
    }
    i--
  }
  // 完全无 API 响应时，全部使用粗算
  return roughTokenCountEstimationForMessages(messages)
}
```

**算法要点**：
1. **精确基准**：从最近一次 API 响应的 `usage` 字段获取准确 token 数，包含 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`
2. **增量估算**：在基准之后新增的消息（如工具结果），用粗算 `roughTokenCountEstimation()` 补充
3. **并行 tool call 回溯**：当模型一次性发出多个工具调用时，streaming 代码会将每个 content block 拆成独立的 assistant 记录（共享同一个 `message.id`），且 query loop 会将 tool_result 交叉插入。如果只从最后一个 assistant 记录计算，会遗漏前面交叉的 tool_result。回溯到同一 `message.id` 的第一个 assistant 记录，确保所有交叉的 tool_result 都被纳入估算

### 2.2 粗算实现

```typescript
// services/tokenEstimation.ts
export function roughTokenCountEstimation(content: string, bytesPerToken = 4): number {
  return Math.round(content.length / bytesPerToken)
}
```

**不同内容类型的计数策略**：
- **text**：`content.length / 4`
- **tool_use**：`block.name + JSON.stringify(block.input)` 的长度 / 4
- **tool_result**：递归计算内容数组
- **image / document**：固定返回 `2000`（`IMAGE_MAX_TOKEN_SIZE` 常量），不管实际尺寸。原因是图片 token = `(width * height) / 750`，API 会将图片限制在 2000x2000 以内，最大约 5333 tokens，取保守值
- **thinking**：只计算 `block.thinking` 文本长度，不计算 signature
- **redacted_thinking**：计算 `block.data` 长度
- **JSON 文件**：特殊处理，`bytesPerToken` 为 2（JSON 多单字符 token 如 `{`、`:`、`,`）

### 2.3 API 精算

```typescript
// services/tokenEstimation.ts
export async function countTokensWithAPI(content: string): Promise<number | null> {
  // 调用 anthropic.beta.messages.countTokens API
  const response = await anthropic.beta.messages.countTokens({
    model: normalizeModelStringForAPI(model),
    messages: [...],
    tools,
    ...(containsThinking && { thinking: { type: 'enabled', budget_tokens: 1024 } }),
  })
  return response.input_tokens
}
```

**降级策略**：当主模型 API 不可用时（如 Vertex global region 不支持 Haiku），使用 `countTokensViaHaikuFallback()` 通过发送 `max_tokens: 1` 的请求来获取 input token 计数。

---

## 三、三层压缩的完整实现

### 3.1 微压缩 (Microcompact) -- 第一道防线

微压缩的核心思想是：**不改变对话结构，只清除旧的工具输出内容**。它有三个子路径。

#### 3.1.1 基于时间的微压缩 (Time-Based MC)

**触发条件**：距离最后一条 assistant 消息超过配置的分钟数（默认 60 分钟，由 GrowthBook 的 `tengu_slate_heron` 配置动态下发）。

**设计理由**：服务端 prompt cache 的 TTL 约 1 小时。超时后 cache 必然失效，整个 prefix 会被重写——在重写前清除旧 tool_result 可以缩小重写体积。

```typescript
// 触发判断
export function evaluateTimeBasedTrigger(messages, querySource) {
  const config = getTimeBasedMCConfig()
  // 必须是主线程请求（prefix match 'repl_main_thread'）
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) return null
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  const gapMinutes = (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (gapMinutes < config.gapThresholdMinutes) return null
  return { gapMinutes, config }
}
```

**信息保留策略**：保留最近 `keepRecent`（默认 5，最少 1）个可压缩工具的结果，其余全部替换为 `'[Old tool result content cleared]'`。

**可压缩工具白名单**：`FileRead, BashTool, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite`。

#### 3.1.2 缓存编辑微压缩 (Cached MC)

这是最精妙的路径——利用 Anthropic API 的 `cache_edits` 功能，在**不破坏服务端 prompt cache** 的情况下删除旧工具结果。

**核心机制**：
1. **不修改本地消息**：消息内容保持不变，通过 API 层的 `cache_reference` 和 `cache_edits` 指令告诉服务端删除指定 `tool_use_id` 的结果
2. **状态追踪**：维护 `CachedMCState`，包含 `registeredTools`（已注册的工具 ID）、`toolOrder`（注册顺序）、`deletedRefs`（已删除的引用）、`pinnedEdits`（已固定的编辑，需在后续请求中重发以维持 cache 命中）
3. **count-based 触发**：当注册的工具数量超过 `triggerThreshold` 时，删除最早的工具结果，保留最近的 `keepRecent` 个

```typescript
// 消费待处理的 cache edits（在 API 请求组装时调用）
export function consumePendingCacheEdits() {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}
```

**beta header latch 机制**：一旦 cached MC 首次触发，`setCacheEditingHeaderLatched(true)` 将 beta header 锁定，后续所有请求都携带该 header，避免 mid-session toggle 改变服务端 cache key 导致约 50-70K tokens 的 cache bust。

#### 3.1.3 API 原生微压缩 (apiMicrocompact.ts)

通过 Anthropic API 的 `context_management` 参数实现服务端清理，支持两种策略：
- `clear_tool_uses_20250919`：按 `input_tokens` 触发，清除旧工具结果/输入
- `clear_thinking_20251015`：清除旧的 thinking blocks

```typescript
export function getAPIContextManagement(options) {
  const strategies: ContextEditStrategy[] = []
  // 思维块清理（非 redact 模式）
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }
  // 工具结果清理（ant-only）
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

### 3.2 会话记忆压缩 (Session Memory Compact) -- 第二道防线

**核心思想**：用已经异步提取好的 session memory 作为摘要替换旧消息，避免额外的 API 调用。

**forked agent 工作原理**：会话记忆的提取（非压缩本身）通过 `runForkedAgent` 执行。forked agent 复用父线程的 prompt cache（`cacheSafeParams.forkContextMessages` 传入主对话的所有消息），在隔离的 context 中运行，`maxTurns: 1`，使用 `NO_TOOLS_PREAMBLE` 阻止工具调用，只产出文本输出。

**触发与执行流程**：
```typescript
// autoCompact.ts -- 在 autoCompactIfNeeded 中优先尝试
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages, toolUseContext.agentId, recompactionInfo.autoCompactThreshold)
if (sessionMemoryResult) {
  // 成功则跳过全量压缩
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}
```

**消息保留策略**（`calculateMessagesToKeepIndex`）：

从 `lastSummarizedMessageId`（session memory 提取器最后处理到的消息 ID）开始向前扩展，直到满足两个最低要求：
- `minTokens`: 10,000（至少保留 10K tokens 的近期消息）
- `minTextBlockMessages`: 5（至少保留 5 条含文本的消息）
- `maxTokens`: 40,000（硬上限，即使未满足上述条件也停止扩展）

同时必须保持 API 不变量：不拆分 `tool_use/tool_result` 对，不分离共享 `message.id` 的 thinking blocks。

**压缩后验证**：如果压缩后的 token 数仍超过 `autoCompactThreshold`，放弃 SM 压缩，回退到全量压缩。

### 3.3 全量压缩 (Full Compact) -- 最后手段

**执行流程**：通过 `compactConversation()` 调用 forked agent，将整个对话发送给模型生成结构化摘要。

**9 段结构化摘要的 prompt 模板** (`prompt.ts`)：

```
Your task is to create a detailed summary of the conversation so far...

1. Primary Request and Intent: 捕获用户的所有显式请求和意图
2. Key Technical Concepts: 列出重要的技术概念、技术和框架
3. Files and Code Sections: 枚举检查/修改/创建的文件，包含完整代码片段
4. Errors and fixes: 列出遇到的所有错误及修复方式，特别关注用户反馈
5. Problem Solving: 记录已解决的问题和进行中的排障
6. All user messages: 列出所有非工具结果的用户消息（理解用户反馈和变化意图的关键）
7. Pending Tasks: 概述尚未完成的显式任务
8. Current Work: 精确描述压缩请求前的当前工作，包含文件名和代码片段
9. Optional Next Step: 列出与最近工作直接相关的下一步，必须引用原始对话
```

**关键设计**：
- **`<analysis>` 草稿区**：要求模型在 `<analysis>` 标签中先组织思路，然后在 `<summary>` 中输出最终摘要。`formatCompactSummary()` 会在后处理中**剥离** analysis 部分，只保留 summary。这实质上是用额外 output tokens 换取摘要质量
- **NO_TOOLS_PREAMBLE**：开头强制声明"不要调用任何工具"，且末尾再次提醒。因为 forked agent 继承父线程的完整工具集（为了 cache-key 匹配），在 Sonnet 4.6+ 上模型可能尝试调用工具，导致 `maxTurns: 1` 浪费
- **partial compact 变体**：支持 `from`（从某消息开始总结）和 `up_to`（总结到某消息为止）两个方向，各有独立 prompt

**压缩后重建**：
```typescript
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,     // 压缩边界标记（含元数据）
    ...result.summaryMessages,  // 摘要
    ...(result.messagesToKeep ?? []),  // 保留的近期消息
    ...result.attachments,      // 文件快照、plan、skill 等
    ...result.hookResults,      // session start hooks 的输出
  ]
}
```

压缩后还会：重新注入最近读取的文件（最多 5 个，每个 5K tokens 上限），重新注入已调用的 skill 内容（每个 5K tokens 上限，总预算 25K），运行 session start hooks，重新发送 deferred tools / agent listing / MCP instructions 的 delta。

---

## 四、自动压缩触发机制

### 4.1 阈值计算

```typescript
// autoCompact.ts
export function getEffectiveContextWindowSize(model: string): number {
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW 环境变量可覆盖
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    contextWindow = Math.min(contextWindow, parseInt(autoCompactWindow, 10))
  }
  // 减去输出预留空间（min(模型 max output, 20K)）
  return contextWindow - reservedTokensForSummary
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 减去 13,000
}
```

**以 200K 窗口为例的计算**：
- `effectiveContextWindow` = 200,000 - min(32,000, 20,000) = **180,000**
- `autoCompactThreshold` = 180,000 - 13,000 = **167,000**
- **触发百分比** = 167,000 / 200,000 = **83.5%**

**以 1M 窗口为例**：
- `effectiveContextWindow` = 1,000,000 - 20,000 = **980,000**
- `autoCompactThreshold` = 980,000 - 13,000 = **967,000**
- **触发百分比** = 967,000 / 1,000,000 = **96.7%**

> 注：之前分析提到的 92.8% 是一个中间值计算。实际阈值因模型和窗口大小而异。

**`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 的作用**：允许用户人为缩小有效上下文窗口。例如在 1M 窗口下设置为 200000，可以让自动压缩在 200K 附近触发，而不是等到接近 1M。这对于希望控制单次 API 调用成本的用户很有用。

### 4.2 熔断器 (Circuit Breaker)

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export async function autoCompactIfNeeded(...) {
  // 连续失败次数达到上限，停止重试
  if (tracking?.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false }
  }

  try {
    const compactionResult = await compactConversation(...)
    return { wasCompacted: true, consecutiveFailures: 0 }  // 成功则重置
  } catch (error) {
    const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging('autocompact: circuit breaker tripped...')
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
```

**设计背景**：BQ 2026-03-10 数据显示，1,279 个 session 出现了 50+ 次连续失败（最高 3,272 次），每天浪费约 250K API 调用。3 次连续失败即触发熔断，停止本 session 的后续自动压缩尝试。成功一次即重置计数。

### 4.3 递归守卫与上下文崩溃互斥

`shouldAutoCompact()` 中有多重递归保护：
- `session_memory` 和 `compact` 来源的请求直接跳过（避免死锁）
- `marble_origami`（上下文崩溃 agent）的请求跳过（避免破坏主线程状态）
- **Context Collapse 互斥**：如果上下文崩溃系统启用，自动压缩完全禁用。因为崩溃系统在 90% commit / 95% blocking 之间工作，而自动压缩在约 93% 触发，会与之竞争

---

## 五、成本追踪

### 5.1 Token 分类

```typescript
// cost-tracker.ts
export function addToTotalSessionCost(cost: number, usage: Usage, model: string) {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  // 按类型计数
  getTokenCounter()?.add(usage.input_tokens, { model, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { model, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, { model, type: 'cacheRead' })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, { model, type: 'cacheCreation' })
}
```

**四类 token 的区分**：
- `input_tokens`：常规输入（未命中缓存的部分）
- `cache_creation_input_tokens`：首次缓存写入的 token（价格较高，如 Sonnet 为 $3.75/Mtok vs 常规 $3/Mtok）
- `cache_read_input_tokens`：缓存命中读取（价格最低，如 Sonnet 为 $0.30/Mtok）
- `output_tokens`：模型输出

### 5.2 成本计算模型

```typescript
// utils/modelCost.ts 定价层级示例
COST_TIER_3_15 = {        // Sonnet 系列
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

### 5.3 会话成本持久化

```typescript
// 保存到项目配置文件
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

恢复时通过 `restoreCostStateForSession(sessionId)` 匹配 `lastSessionId`，只有同一 session 才会恢复累计成本。

---

## 六、上下文窗口扩展 -- 1M Token 支持

### 6.1 启用条件

```typescript
// utils/context.ts
export function getContextWindowForModel(model: string, betas?: string[]): number {
  // 1. 环境变量覆盖（ant-only）
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) { return parseInt(...) }
  // 2. [1m] 后缀 -- 显式客户端 opt-in
  if (has1mContext(model)) { return 1_000_000 }  // /\[1m\]/i.test(model)
  // 3. 模型能力查询
  if (cap?.max_input_tokens >= 100_000) { return cap.max_input_tokens }
  // 4. beta header 信号
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) { return 1_000_000 }
  // 5. A/B 实验
  if (getSonnet1mExpTreatmentEnabled(model)) { return 1_000_000 }
  // 6. 默认 200K
  return 200_000
}
```

**支持 1M 的模型**：`claude-sonnet-4`（含 4.6）和 `claude-opus-4-6`。

**HIPAA 合规开关**：`CLAUDE_CODE_DISABLE_1M_CONTEXT` 环境变量，硬性禁用 1M，即使模型能力报告支持也强制降到 200K。

### 6.2 Beta Header Latch 机制

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

**Latch 原理**：beta header 是服务端 prompt cache key 的一部分。如果一个 header 在 session 中途被添加或移除，cache key 变化，之前缓存的 50-70K tokens 的 prompt prefix 全部失效。Latch 机制确保 header 一旦首次发送就**永远保持发送**，直到 `/clear` 或 `/compact` 显式清除。

**现有 latch**：
- `afkModeHeaderLatched`：AFK 模式
- `fastModeHeaderLatched`：快速模式
- `cacheEditingHeaderLatched`：缓存编辑（cached MC）
- `thinkingClearLatched`：thinking 清理（idle > 1h 时触发）

---

## 七、消息分组与部分压缩

### 7.1 API Round 分组

```typescript
// grouping.ts
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  // 按 assistant message.id 边界分组
  // 同一 API 响应的 streaming chunks 共享 id，保持在同一组
  // 正确处理 [tu_A(id=X), result_A, tu_B(id=X)] 场景
}
```

这是压缩重试时"丢弃最老 group"策略的基础。当压缩请求本身触发 `prompt_too_long` 时（CC-1180），`truncateHeadForPTLRetry()` 按 API round group 丢弃最老的消息组，最多重试 3 次。

### 7.2 Token Budget 系统

用户可以通过自然语言指定 token 预算（如 `+500k`、`use 2M tokens`），系统通过正则解析：

```typescript
// utils/tokenBudget.ts
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
```

Budget tracker 监控每轮 output tokens，在 90% 完成度时判断是否继续，并检测递减收益（连续 3 轮增量 < 500 tokens 则停止）。

---

## 八、压缩后清理 (postCompactCleanup)

压缩后需要重置多项全局状态：

```typescript
export function runPostCompactCleanup(querySource?: QuerySource): void {
  resetMicrocompactState()            // 清除 cached MC 状态
  resetContextCollapse()              // 清除上下文崩溃状态（仅主线程）
  getUserContext.cache.clear?.()      // 清除 CLAUDE.md 缓存（仅主线程）
  resetGetMemoryFilesCache('compact') // 重置内存文件缓存
  clearSystemPromptSections()         // 清除系统提示段落
  clearClassifierApprovals()          // 清除分类器审批
  clearSpeculativeChecks()            // 清除推测性检查
  clearBetaTracingState()             // 清除 beta 追踪状态
  clearSessionMessagesCache()         // 清除会话消息缓存
  // 注意：不清除 invoked skill content（需跨压缩保留）
  // 注意：不重置 sentSkillNames（避免重新注入 ~4K token 的 skill_listing）
}
```

**子代理保护**：通过 `querySource` 判断是否为主线程压缩。子代理（`agent:*`）与主线程共享模块级状态，如果子代理压缩时重置了主线程的状态（如 context-collapse store、getUserContext 缓存），会导致主线程数据损坏。

---

## 九、设计权衡总结

1. **精度 vs 性能**：`tokenCountWithEstimation` 混合了 API 精确值和字符长度粗算，在大多数场景下偏差可控（粗算部分使用 4/3 放大因子做保守估计），避免了每次都调用 count tokens API 的延迟

2. **Cache 保护 vs 信息保留**：Cached MC 牺牲了一定的信息（删除旧工具结果），换取了 prompt cache 命中率。Time-based MC 在 cache 必然失效时才触发，是最"无损"的微压缩时机

3. **三层压缩的递进关系**：微压缩零 API 调用成本、会话记忆压缩复用已有的异步提取结果、全量压缩有完整的 API 调用开销。优先级从低成本到高成本逐级升级

4. **熔断器的保守性**：3 次失败即熔断看似激进，但考虑到每次压缩本身消耗大量 tokens（p99.99 output 为 17,387 tokens），连续 3 次失败意味着已浪费超过 50K output tokens，且上下文很可能"不可恢复地"超限

5. **Latch 的 session 粒度**：beta header latch 保证了 session 内的 cache 稳定性，但也意味着 session 内无法动态切换某些功能。这是一个明确的"cache 效率优先于功能灵活性"的设计选择
