# 08 - MCP 集成与服务层深度分析

## 概述

Claude Code 的服务层（`src/services/`）包含约 130 个文件，涵盖 MCP 协议集成、Anthropic API 客户端、OAuth 认证、插件系统、技能系统等核心功能。本文档基于源码最大深度分析，覆盖 `services/mcp/`（23 文件）、`services/api/`（20 文件）、`services/oauth/`、`services/plugins/`、`skills/`、`tools/MCPTool/` 等全部相关模块。

---

## 一、MCP 协议实现：8 种传输层

### 1.1 传输类型定义（types.ts）

MCP 类型系统通过 Zod schema 定义了完整的传输联合类型：

```typescript
// types.ts — 传输类型枚举
export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
```

加上代码中实际处理的 `ws-ide` 和 `claudeai-proxy`，共 **8 种传输类型**。每种传输都有独立的 Zod schema 验证配置：

### 1.2 传输类型完整对比表

| 传输类型 | Schema | 连接方式 | OAuth 支持 | 适用场景 | 关键限制 |
|---------|--------|---------|-----------|---------|---------|
| **stdio** | `McpStdioServerConfigSchema` | `StdioClientTransport` 子进程 | 无 | 本地命令行 MCP 服务器 | 需 spawn 进程，env 通过 `subprocessEnv()` 注入 |
| **sse** | `McpSSEServerConfigSchema` | `SSEClientTransport` + EventSource | 完整（OAuth + XAA） | 远程 SSE 服务器 | EventSource 长连接不加超时；POST 请求 60s 超时 |
| **sse-ide** | `McpSSEIDEServerConfigSchema` | `SSEClientTransport`（无 auth） | 无 | IDE 扩展内部连接 | 仅允许 `mcp__ide__executeCode` 和 `mcp__ide__getDiagnostics` |
| **http** | `McpHTTPServerConfigSchema` | `StreamableHTTPClientTransport` | 完整（OAuth + XAA） | 远程 Streamable HTTP 服务器 | Accept: `application/json, text/event-stream` 必须设置 |
| **ws** | `McpWebSocketServerConfigSchema` | `WebSocketTransport`（自定义） | 无（headersHelper 支持） | WebSocket 远程服务器 | Bun/Node 双路径适配；支持 mTLS |
| **ws-ide** | `McpWebSocketIDEServerConfigSchema` | `WebSocketTransport` + authToken | 无 | IDE WebSocket 连接 | 通过 `X-Claude-Code-Ide-Authorization` 认证 |
| **sdk** | `McpSdkServerConfigSchema` | `SdkControlClientTransport` | 无 | SDK 进程内 MCP 服务器 | 通过 stdout/stdin 控制消息桥接 |
| **claudeai-proxy** | `McpClaudeAIProxyServerConfigSchema` | `StreamableHTTPClientTransport` | Claude.ai OAuth | claude.ai 组织管理的 MCP 连接器 | 通过 `MCP_PROXY_URL` 代理；自动 401 重试 |

### 1.3 特殊传输：InProcessTransport

```typescript
// InProcessTransport.ts — 进程内链式传输对
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  async send(message: JSONRPCMessage): Promise<void> {
    // 通过 queueMicrotask 异步传递，避免同步请求/响应导致栈溢出
    queueMicrotask(() => { this.peer?.onmessage?.(message) })
  }
}
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b); b._setPeer(a)
  return [a, b]
}
```

用于两种场景：
1. **Chrome MCP 服务器**：`isClaudeInChromeMCPServer(name)` 时启用，避免 spawn ~325MB 子进程
2. **Computer Use MCP 服务器**：`feature('CHICAGO_MCP')` 门控下的计算机使用功能

### 1.4 特殊传输：SdkControlTransport

SDK 传输桥接实现了 CLI 进程与 SDK 进程间的 MCP 通信：

```
CLI → SDK: SdkControlClientTransport.send() → 控制消息(stdout) → SDK StructuredIO → 路由到对应server
SDK → CLI: MCP server → SdkControlServerTransport.send() → callback → 控制消息解析 → onmessage
```

关键设计：`SdkControlClientTransport` 通过 `sendMcpMessage` 回调将 JSONRPC 消息包装为控制请求（含 `server_name` 和 `request_id`），SDK 端的 StructuredIO 负责路由和响应关联。

### 1.5 连接状态机

```
         ┌─────────┐
         │ pending  │ ←──── 初始 / 重连
         └────┬─────┘
              │ connectToServer()
    ┌─────────┼──────────┬──────────────┐
    ▼         ▼          ▼              ▼
┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐
│connected│ │ failed │ │needs-auth│ │ disabled │
└────┬────┘ └───┬────┘ └────┬─────┘ └──────────┘
     │          │           │
     │ 401/     │ auto-     │ performMCPOAuthFlow()
     │ expired  │ reconnect │ performMCPXaaAuth()
     │          │           │
     ▼          ▼           ▼
┌──────────┐ ┌─────────┐ ┌─────────┐
│needs-auth│ │ pending │ │connected│
└──────────┘ └─────────┘ └─────────┘
```

五种状态通过 TypeScript 联合类型严格定义：

```typescript
export type MCPServerConnection =
  | ConnectedMCPServer    // client + capabilities + cleanup
  | FailedMCPServer       // error message
  | NeedsAuthMCPServer    // 等待 OAuth
  | PendingMCPServer      // reconnectAttempt / maxReconnectAttempts
  | DisabledMCPServer     // 用户主动禁用
```

重连策略（`useManageMCPConnections.ts`）：
- 最大重连次数：`MAX_RECONNECT_ATTEMPTS = 5`
- 指数退避：`INITIAL_BACKOFF_MS = 1000` → `MAX_BACKOFF_MS = 30000`
- 连接超时：`getConnectionTimeoutMs()` 默认 30s，可通过 `MCP_TIMEOUT` 环境变量覆盖

### 1.6 连接批处理

```typescript
// 本地服务器（stdio/sdk）：并发 3 个
export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}
// 远程服务器（sse/http/ws 等）：并发 20 个
function getRemoteMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 20
}
```

本地和远程服务器分开批处理，远程并发更高以利用网络 I/O。

---

## 二、API 客户端深度

### 2.1 getAnthropicClient：4 种后端

`services/api/client.ts` 的 `getAnthropicClient()` 是 API 访问的统一入口，通过环境变量选择后端：

```typescript
export async function getAnthropicClient({ apiKey, maxRetries, model, fetchOverride, source }) {
  // 公共参数
  const ARGS = { defaultHeaders, maxRetries, timeout: 600_000, dangerouslyAllowBrowser: true, ... }

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // 1. AWS Bedrock — AnthropicBedrock SDK
    //    支持 awsRegion / awsAccessKey / awsSecretKey / awsSessionToken
    //    ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION 可为 Haiku 指定独立 region
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    // 2. Azure Foundry — AnthropicFoundry SDK
    //    支持 ANTHROPIC_FOUNDRY_API_KEY 或 Azure AD DefaultAzureCredential
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // 3. Google Vertex AI — AnthropicVertex SDK
    //    GoogleAuth scopes: cloud-platform
    //    项目ID回退链: 环境变量 → 凭证文件 → ANTHROPIC_VERTEX_PROJECT_ID
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }
  // 4. 直接 API — 标准 Anthropic SDK
  //    apiKey（外部） vs authToken（Claude.ai 订阅者）
  return new Anthropic({
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber() ? getClaudeAIOAuthTokens()?.accessToken : undefined,
    ...ARGS,
  })
}
```

关键细节：
- **所有后端的 maxRetries 在 SDK 层设为 0**，重试逻辑由 `withRetry.ts` 统一管理
- **自定义 headers**：`ANTHROPIC_CUSTOM_HEADERS` 环境变量注入任意 header（支持 HFI 调试场景）
- **代理支持**：`getProxyFetchOptions({ forAnthropicAPI: true })` 对 Anthropic API 启用代理

### 2.2 流式/非流式查询

`services/api/claude.ts` 中的 `queryModel` 是核心查询函数。流式和非流式模式的差异：

**流式模式**（主路径）：
```typescript
// claude.ts 中 createStream() 使用 withStreamingVCR 包装
for await (const message of withStreamingVCR(messages, async function* () {
  yield* queryModel(messages, /* ... streaming: true */)
}))
```

**非流式回退**：
- 当流式请求遇到 529 overloaded 错误时，`withRetry` 触发 `FallbackTriggeredError`
- 回退到 Sonnet 模型（`options.fallbackModel`）

### 2.3 Prompt 缓存（cache_control）

`cache_control` 标记的放置策略极为精细（`claude.ts`）：

1. **每请求仅一个标记点**：Mycro 的 KV 页面驱逐机制要求单一 `cache_control` 标记
2. **标记位置**：最后一条消息的最后一个 content block
3. **缓存作用域**：
   ```typescript
   function getCacheControl({ scope, querySource }): { type: string } {
     // 'global' scope: type = 'ephemeral_1h'（1小时全局缓存）
     // 默认: type = 'ephemeral'（5分钟短暂缓存）
   }
   ```
4. **cache_reference**：在 `cache_control` 标记之前的 `tool_result` blocks 上添加 `cache_reference`，避免重复传输已缓存内容
5. **1h 缓存资格**：通过 GrowthBook feature flag `tengu_prompt_cache_1h` + 允许列表双重门控

### 2.4 重试与降级策略（withRetry.ts）

`withRetry` 是一个 `AsyncGenerator`，可通过 `yield` 向调用方报告重试状态：

| 错误类型 | 重试策略 | 降级策略 |
|---------|---------|---------|
| 401 Unauthorized | 刷新 OAuth token / API key 缓存 | 重建 client 实例 |
| 403 Token Revoked | `handleOAuth401Error` 强制刷新 | 同 401 |
| 429 Rate Limit | 指数退避（base 500ms，max 32s） | Fast mode: 切换到标准速度 |
| 529 Overloaded | 最多 3 次 → `FallbackTriggeredError` | Opus → Sonnet 模型降级 |
| 400 Context Overflow | 调整 `maxTokensOverride` | 保留 >=3000 output tokens |
| AWS/GCP Auth Error | 清除凭证缓存后重试 | 重建 client |
| ECONNRESET/EPIPE | `disableKeepAlive()` 后重试 | 禁用连接池 |

**Persistent Retry 模式**（`CLAUDE_CODE_UNATTENDED_RETRY`）：
- 无人值守场景，429/529 **无限重试**
- 退避上限 5 分钟，重置窗口上限 6 小时
- 每 30 秒发送心跳（SystemAPIErrorMessage yield），防止会话被标记为空闲

**Fast Mode 降级**：
- 短 retry-after（<20s）：保持 fast mode 重试（保护 prompt cache）
- 长 retry-after（>=20s）：进入冷却期（至少 10 分钟），切换到标准速度

---

## 三、OAuth PKCE 完整流程

### 3.1 标准 MCP OAuth 流程（auth.ts: performMCPOAuthFlow）

```
用户发起 /mcp 认证
       │
       ▼
[1] 检查 oauth.xaa → 是 → 走 XAA 流程（见下节）
       │ 否
       ▼
[2] clearServerTokensFromLocalStorage (清除旧 token)
       │
       ▼
[3] fetchAuthServerMetadata
    RFC 9728 PRM → authorization_servers[0] → RFC 8414 AS 元数据
    回退: RFC 8414 直接对 MCP URL (path-aware)
       │
       ▼
[4] new ClaudeAuthProvider(serverName, serverConfig, redirectUri)
       │
       ▼
[5] 启动本地 HTTP server (127.0.0.1:{port}/callback)
    - port: oauth.callbackPort 或 findAvailablePort()
    - 监听 code + state 参数
       │
       ▼
[6] sdkAuth() → 浏览器打开授权 URL (PKCE: code_challenge_method=S256)
       │
       ▼
[7] 用户在浏览器授权 → 回调到 localhost
    - 验证 state 防 CSRF
    - 提取 authorization code
       │
       ▼
[8] sdkAuth() 交换 code → tokens (access_token + refresh_token)
       │
       ▼
[9] ClaudeAuthProvider.saveTokens() → keychain (SecureStorage)
    存储结构: mcpOAuth[serverKey] = {
      serverName, serverUrl, accessToken, refreshToken,
      expiresAt, scope, clientId, clientSecret, discoveryState
    }
```

### 3.2 Token 刷新

`ClaudeAuthProvider` 实现 `OAuthClientProvider` 接口，`tokens()` 方法在每次 MCP 请求时被调用：

```
ClaudeAuthProvider.tokens()
    │
    ├── 检查 accessToken 是否过期
    │   ├── 未过期 → 返回 { access_token, refresh_token }
    │   └── 已过期 → _doRefresh()
    │       ├── fetchAuthServerMetadata() → 获取 token_endpoint
    │       ├── sdkRefreshAuthorization() → POST /token (grant_type=refresh_token)
    │       ├── 成功 → saveTokens() → 返回新 tokens
    │       └── 失败 →
    │           ├── invalid_grant → invalidateCredentials('tokens') + 删除旧 token
    │           ├── 5xx/transient → 重试最多 2 次，间隔 2s
    │           └── 其他 → 抛出错误，标记 needs-auth
    │
    └── XAA 路径: xaaRefresh()
        ├── 检查 IdP id_token 缓存
        ├── performCrossAppAccess() (不弹浏览器)
        └── 保存新 tokens
```

### 3.3 Step-Up Authentication

```typescript
// auth.ts: wrapFetchWithStepUpDetection
export function wrapFetchWithStepUpDetection(baseFetch, provider): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init)
    if (response.status === 403) {
      const wwwAuth = response.headers.get('WWW-Authenticate')
      // 解析 scope 和 resource_metadata 参数
      // 持久化到 keychain (stepUpScope + discoveryState.resourceMetadataUrl)
      // 设置 forceReauth → tokens() 下次省略 refresh_token → 触发 PKCE 重新授权
    }
    return response
  }
}
```

---

## 四、MCP OAuth XAA（跨应用访问）

### 4.1 架构概述

XAA (Cross-App Access / SEP-990) 实现了**一次 IdP 登录，N 个 MCP 服务器静默认证**的能力。核心在 `xaa.ts` 和 `xaaIdpLogin.ts`。

### 4.2 完整 XAA 流程

```
[配置] settings.xaaIdp = { issuer, clientId, callbackPort? }
[配置] server.oauth = { clientId, xaa: true }
[配置] keychain: mcpOAuthClientConfig[serverKey].clientSecret

performMCPXaaAuth(serverName, serverConfig)
    │
    ▼
[1] acquireIdpIdToken(idpIssuer, idpClientId)
    ├── getCachedIdpIdToken() → 命中缓存 → 直接返回
    └── 缓存未命中 →
        ├── discoverOidc(issuer) → .well-known/openid-configuration
        ├── startAuthorization() (PKCE: code_challenge_method=S256)
        ├── openBrowser(authorizationUrl) ← 唯一的浏览器弹出
        ├── waitForCallback(port, state, abortSignal)
        ├── exchangeAuthorization() → { id_token, access_token, ... }
        └── saveIdpIdToken(issuer, id_token, expiresAt) → keychain
    │
    ▼
[2] performCrossAppAccess(serverUrl, xaaConfig)
    │
    ├── [Layer 2] discoverProtectedResource(serverUrl) → RFC 9728 PRM
    │   验证: prm.resource === serverUrl (mix-up protection)
    │
    ├── [Layer 2] discoverAuthorizationServer(asUrl) → RFC 8414
    │   验证: meta.issuer === asUrl (mix-up protection)
    │   验证: token_endpoint 必须 HTTPS
    │   检查: grant_types_supported 包含 jwt-bearer
    │
    ├── [Layer 2] requestJwtAuthorizationGrant()
    │   RFC 8693 Token Exchange: id_token → ID-JAG
    │   POST IdP_token_endpoint:
    │     grant_type = urn:ietf:params:oauth:grant-type:token-exchange
    │     requested_token_type = urn:ietf:params:oauth:token-type:id-jag
    │     subject_token = id_token
    │     subject_token_type = urn:ietf:params:oauth:token-type:id_token
    │     audience = AS_issuer, resource = PRM_resource
    │
    └── [Layer 2] exchangeJwtAuthGrant()
        RFC 7523 JWT Bearer: ID-JAG → access_token
        POST AS_token_endpoint:
          grant_type = urn:ietf:params:oauth:grant-type:jwt-bearer
          assertion = ID-JAG
          认证方式: client_secret_basic (默认) 或 client_secret_post
    │
    ▼
[3] 保存 tokens 到 keychain (mcpOAuth[serverKey])
    包含 discoveryState.authorizationServerUrl 用于后续刷新
```

### 4.3 XAA 错误处理的精细分类

```typescript
// XaaTokenExchangeError 携带 shouldClearIdToken 标记
// 4xx / invalid_grant → id_token 无效，清除缓存
// 5xx → IdP 宕机，id_token 可能仍有效，保留
// 200 + 非法 body → 协议违规，清除
```

XAA 对敏感信息（token、assertion、client_secret）在日志中做了严格脱敏：

```typescript
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g
function redactTokens(raw) {
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}
```

---

## 五、MCP 配置系统（config.ts）

### 5.1 配置作用域

```typescript
export type ConfigScope = 'local' | 'user' | 'project' | 'dynamic' | 'enterprise' | 'claudeai' | 'managed'
```

配置加载优先级（`getAllMcpConfigs`）：
1. **Enterprise** (`managed-mcp.json`)：存在时禁用 claude.ai 连接器
2. **User** (`~/.claude/settings.json` 中的 `mcpServers`)
3. **Project** (`.mcp.json` 或 `.claude/settings.local.json`)
4. **Plugin**：通过 `getPluginMcpServers()` 提供
5. **Claude.ai**：通过 `fetchClaudeAIMcpConfigsIfEligible()` API 获取
6. **Dynamic**：运行时动态注入（SDK 等）

### 5.2 去重策略

三层去重防止同一 MCP 服务器重复连接：

```typescript
// 1. 插件 vs 手动配置去重
dedupPluginMcpServers(pluginServers, manualServers)
// 签名比较: stdio → "stdio:" + JSON(commandArray)
//           remote → "url:" + unwrapCcrProxyUrl(url)

// 2. Claude.ai 连接器 vs 手动配置去重
dedupClaudeAiMcpServers(claudeAiServers, manualServers)
// 仅用启用的手动服务器作为去重目标

// 3. CCR 代理 URL 解包
unwrapCcrProxyUrl(url) // 提取 mcp_url 查询参数中的原始供应商 URL
```

### 5.3 企业策略（Allowlist / Denylist）

```typescript
// Denylist 绝对优先 — 三种匹配方式
isMcpServerDenied(name, config)
  ├── isMcpServerNameEntry(entry)    // 按名称
  ├── isMcpServerCommandEntry(entry) // 按命令数组（stdio）
  └── isMcpServerUrlEntry(entry)     // 按 URL 通配符模式

// Allowlist — allowManagedMcpServersOnly 时仅用 policySettings
isMcpServerAllowedByPolicy(name, config)
```

---

## 六、插件架构

### 6.1 目录结构

```
services/plugins/
  PluginInstallationManager.ts  — 后台安装管理器
  pluginOperations.ts           — 增删改操作
  pluginCliCommands.ts          — CLI 命令接口
```

### 6.2 Marketplace 与插件生命周期

```
启动时:
  loadAllPluginsCacheOnly()     ← 仅从缓存加载（不阻塞启动）
后台:
  performBackgroundPluginInstallations()
    ├── getDeclaredMarketplaces()     → settings 中声明的 marketplace
    ├── loadKnownMarketplacesConfig() → 已物化的 marketplace 配置
    ├── diffMarketplaces()            → 计算 missing / sourceChanged
    └── reconcileMarketplaces()       → clone/update Git 仓库
        └── onProgress: installing → installed | failed

安装完成后:
  ├── refreshActivePlugins() → 重新加载插件
  └── 或 needsRefresh → 显示通知提示 /reload-plugins
```

### 6.3 插件如何提供 MCP 服务器

插件通过 `getPluginMcpServers()` 注入 MCP 服务器配置。插件服务器的命名空间为 `plugin:<name>:<server>`，不会与手动配置键冲突。但内容去重（`dedupPluginMcpServers`）会检测相同 command/url 的重复。

每个插件 MCP 服务器配置上附带 `pluginSource` 字段（如 `'slack@anthropic'`），用于 channel 权限控制时的快速查找，无需等待 `AppState.plugins.enabled` 异步加载完成。

---

## 七、Skills 系统

### 7.1 三个来源及加载优先级

| 来源 | 目录 | LoadedFrom | 加载时机 |
|-----|------|-----------|---------|
| **内置（Bundled）** | `skills/bundled/` | `'bundled'` | `initBundledSkills()` 启动时同步注册 |
| **目录（Disk）** | `.claude/skills/`, `~/.claude/skills/` | `'skills'` | `loadSkillsDir()` 扫描 Markdown 文件 |
| **MCP** | 远程 MCP 服务器 prompts | `'mcp'` | `fetchMcpSkillsForClient()` 连接时获取 |

### 7.2 内置技能注册

```typescript
// skills/bundled/index.ts — initBundledSkills()
registerUpdateConfigSkill()   // /update-config
registerKeybindingsSkill()    // /keybindings-help
registerVerifySkill()         // /verify
registerDebugSkill()          // /debug
registerLoremIpsumSkill()     // /lorem-ipsum
registerSkillifySkill()       // /skillify
registerRememberSkill()       // /remember
registerSimplifySkill()       // /simplify
registerBatchSkill()          // /batch
registerStuckSkill()          // /stuck
// Feature-gated:
registerDreamSkill()          // KAIROS / KAIROS_DREAM
registerHunterSkill()         // REVIEW_ARTIFACT
registerLoopSkill()           // AGENT_TRIGGERS
registerScheduleRemoteAgentsSkill() // AGENT_TRIGGERS_REMOTE
registerClaudeApiSkill()      // CLAUDE_API
registerClaudeInChromeSkill() // auto-enable condition
```

`registerBundledSkill` 将 `BundledSkillDefinition` 转换为 `Command` 对象并推入全局 `bundledSkills` 数组。支持 `files` 字段延迟解压到磁盘（`getBundledSkillExtractDir`），通过 `O_NOFOLLOW|O_EXCL` 标志防符号链接攻击。

### 7.3 Write-Once Registry 模式（mcpSkillBuilders.ts）

```typescript
// mcpSkillBuilders.ts — 依赖图叶节点，无导入
export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b  // 写一次
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) throw new Error('MCP skill builders not registered')
  return builders
}
```

这个模式解决了循环依赖问题：`client.ts → mcpSkills.ts → loadSkillsDir.ts → ... → client.ts`。通过将 builders 注册延迟到模块初始化时（`loadSkillsDir.ts` 通过 `commands.ts` 的静态导入在启动时被 eagerly 求值），保证 MCP 服务器连接时 builders 已就绪。

### 7.4 Markdown 技能文件格式

```markdown
---
description: 技能描述文本
when-to-use: 触发条件描述
argument-hint: 参数提示
allowed-tools: Bash, Read, Edit
model: claude-sonnet-4-20250514
context: inline | fork
hooks:
  preToolUse:
    - pattern: "*"
      command: echo "pre-hook"
---

### 技能 Prompt 内容

实际的 system prompt 文本...
```

前置数据由 `parseFrontmatter()` 解析，支持：
- `allowed-tools`：限制技能可用的工具列表
- `model`：覆盖默认模型
- `context: fork`：在子 agent 中运行
- `hooks`：技能级别的 pre/post 钩子

---

## 八、MCPTool 工具集成

### 8.1 MCPTool 定义（tools/MCPTool/MCPTool.ts）

```typescript
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',  // 在 client.ts 中被覆盖为实际 MCP 工具名
  maxResultSizeChars: 100_000,
  // description, prompt, call, userFacingName 都在 client.ts 中覆盖
  async checkPermissions(): Promise<PermissionResult> {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
})
```

MCPTool 是一个**模板对象**，在 `client.ts` 的 `fetchToolsForClient()` 中为每个 MCP 服务器暴露的工具创建定制副本，设置：
- `name`: `mcp__{normalizedServerName}__{normalizedToolName}`（双下划线分隔）
- `description`: 截断到 `MAX_MCP_DESCRIPTION_LENGTH = 2048` 字符
- `call`: 封装 `client.callTool()` + 超时 + 结果格式化 + 图片处理

### 8.2 工具调用链

```
LLM 输出 tool_use(name="mcp__github__create_issue", input={...})
    │
    ▼
MCPTool.call(input)
    │
    ├── 查找对应 ConnectedMCPServer
    ├── client.callTool({ name: originalToolName, arguments: input })
    │   ├── 超时: getMcpToolTimeoutMs() 默认 ~27.8 小时
    │   ├── 401 → McpAuthError → 标记 needs-auth
    │   └── 404 + -32001 → McpSessionExpiredError → 清除缓存 → 重建连接
    │
    ├── 结果处理:
    │   ├── isError: true → McpToolCallError
    │   ├── 图片: maybeResizeAndDownsampleImageBuffer()
    │   ├── 大型输出: truncateMcpContentIfNeeded()
    │   └── 二进制: persistBinaryContent() → 保存到磁盘
    │
    └── 返回格式化文本结果
```

---

## 九、Channel Notifications（MCP 推送消息）

Channel 通知让 MCP 服务器（如 Discord/Slack/Telegram 机器人）向对话推送消息：

```typescript
// channelNotification.ts
export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)
```

通知处理流程：
1. MCP 服务器发送 `notifications/claude/channel` 通知
2. 内容被包装为 `<channel source="..." chat_id="..." ...>` XML 标签
3. 通过 `enqueue()` 推入消息队列
4. `SleepTool` 的 `hasCommandsInQueue()` 检测到新消息，1 秒内唤醒
5. 模型看到 `<channel>` 标签后决定如何响应

权限安全：`ChannelPermissionNotificationSchema` 支持结构化权限回复（`{request_id, behavior}`），避免文本消息意外匹配权限确认。

---

## 十、其他关键辅助模块

### 10.1 officialRegistry.ts
```typescript
// 预取 Anthropic 官方 MCP 注册表
export async function prefetchOfficialMcpUrls(): Promise<void> {
  // GET https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial
  // 用于 isOfficialMcpUrl() 判断 — 影响信任等级和 UI 显示
}
```

### 10.2 normalization.ts
```typescript
// MCP 名称标准化: ^[a-zA-Z0-9_-]{1,64}$
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith('claude.ai ')) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
```

### 10.3 headersHelper.ts
动态 header 注入机制 — 通过执行外部脚本生成 header：
- 项目/本地设置中的 `headersHelper` 需通过信任检查
- 脚本超时执行，结果解析为 JSON 对象
- 与静态 `headers` 合并后用于所有 MCP 请求

### 10.4 envExpansion.ts
环境变量展开：MCP 配置中 `${VAR}` 风格的引用在连接时被展开为实际值。

### 10.5 elicitationHandler.ts
MCP 服务器可通过 Elicitation 协议向用户收集信息：
- **Form 模式**：结构化表单
- **URL 模式**：重定向到外部 URL 后等待完成通知
- 通过 `ElicitationCompleteNotification` 实现异步完成通知

---

## 小结

Claude Code 的 MCP 集成是一个完整的协议客户端实现，包含 8 种传输、完整的 OAuth/XAA 认证链、企业级策略控制和弹性重试机制。API 客户端统一了 4 种云后端的访问方式，prompt 缓存策略在 token 级别精细控制。Skills 系统通过 bundled + disk + MCP 三源汇聚，write-once registry 模式优雅地解决了循环依赖问题。插件系统以 marketplace 为分发单元，后台安装不阻塞启动。
