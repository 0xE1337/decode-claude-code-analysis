# 08 - Deep Analysis of MCP Integration and Service Layer

## Overview

Claude Code's service layer (`src/services/`) contains approximately 130 files, covering MCP protocol integration, Anthropic API client, OAuth authentication, plugin system, skills system, and other core functionalities. This document is based on a maximum-depth source code analysis, covering all related modules including `services/mcp/` (23 files), `services/api/` (20 files), `services/oauth/`, `services/plugins/`, `skills/`, `tools/MCPTool/`, and more.

---

## 1. MCP Protocol Implementation: 8 Transport Types

### 1.1 Transport Type Definitions (types.ts)

The MCP type system defines a complete transport union type through Zod schemas:

```typescript
// types.ts — Transport type enum
export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
```

Including `ws-ide` and `claudeai-proxy` which are handled in the actual code, there are **8 transport types** in total. Each transport has its own independent Zod schema for configuration validation:

### 1.2 Complete Transport Type Comparison Table

| Transport Type | Schema | Connection Method | OAuth Support | Use Case | Key Limitations |
|---------|--------|---------|-----------|---------|---------|
| **stdio** | `McpStdioServerConfigSchema` | `StdioClientTransport` subprocess | None | Local CLI MCP servers | Requires process spawn; env injected via `subprocessEnv()` |
| **sse** | `McpSSEServerConfigSchema` | `SSEClientTransport` + EventSource | Full (OAuth + XAA) | Remote SSE servers | EventSource long connection has no timeout; POST requests timeout at 60s |
| **sse-ide** | `McpSSEIDEServerConfigSchema` | `SSEClientTransport` (no auth) | None | IDE extension internal connections | Only allows `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` |
| **http** | `McpHTTPServerConfigSchema` | `StreamableHTTPClientTransport` | Full (OAuth + XAA) | Remote Streamable HTTP servers | Accept: `application/json, text/event-stream` must be set |
| **ws** | `McpWebSocketServerConfigSchema` | `WebSocketTransport` (custom) | None (headersHelper supported) | WebSocket remote servers | Dual-path adaptation for Bun/Node; supports mTLS |
| **ws-ide** | `McpWebSocketIDEServerConfigSchema` | `WebSocketTransport` + authToken | None | IDE WebSocket connections | Authenticated via `X-Claude-Code-Ide-Authorization` |
| **sdk** | `McpSdkServerConfigSchema` | `SdkControlClientTransport` | None | SDK in-process MCP servers | Bridged via stdout/stdin control messages |
| **claudeai-proxy** | `McpClaudeAIProxyServerConfigSchema` | `StreamableHTTPClientTransport` | Claude.ai OAuth | claude.ai organization-managed MCP connectors | Proxied via `MCP_PROXY_URL`; automatic 401 retry |

### 1.3 Special Transport: InProcessTransport

```typescript
// InProcessTransport.ts — In-process linked transport pair
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  async send(message: JSONRPCMessage): Promise<void> {
    // Async delivery via queueMicrotask to avoid stack overflow from synchronous request/response
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

Used in two scenarios:
1. **Chrome MCP Server**: Enabled when `isClaudeInChromeMCPServer(name)`, avoiding spawning a ~325MB subprocess
2. **Computer Use MCP Server**: Computer use functionality gated under `feature('CHICAGO_MCP')`

### 1.4 Special Transport: SdkControlTransport

The SDK transport bridge implements MCP communication between the CLI process and SDK process:

```
CLI → SDK: SdkControlClientTransport.send() → control message (stdout) → SDK StructuredIO → route to corresponding server
SDK → CLI: MCP server → SdkControlServerTransport.send() → callback → control message parsing → onmessage
```

Key design: `SdkControlClientTransport` wraps JSONRPC messages as control requests (containing `server_name` and `request_id`) through the `sendMcpMessage` callback. The SDK-side StructuredIO handles routing and response correlation.

### 1.5 Connection State Machine

```
         ┌─────────┐
         │ pending  │ ←──── initial / reconnect
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

Five states are strictly defined through TypeScript union types:

```typescript
export type MCPServerConnection =
  | ConnectedMCPServer    // client + capabilities + cleanup
  | FailedMCPServer       // error message
  | NeedsAuthMCPServer    // awaiting OAuth
  | PendingMCPServer      // reconnectAttempt / maxReconnectAttempts
  | DisabledMCPServer     // user-disabled
```

Reconnection strategy (`useManageMCPConnections.ts`):
- Maximum reconnection attempts: `MAX_RECONNECT_ATTEMPTS = 5`
- Exponential backoff: `INITIAL_BACKOFF_MS = 1000` to `MAX_BACKOFF_MS = 30000`
- Connection timeout: `getConnectionTimeoutMs()` defaults to 30s, overridable via `MCP_TIMEOUT` environment variable

### 1.6 Connection Batching

```typescript
// Local servers (stdio/sdk): concurrency of 3
export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}
// Remote servers (sse/http/ws, etc.): concurrency of 20
function getRemoteMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 20
}
```

Local and remote servers are batched separately, with higher concurrency for remote servers to leverage network I/O.

---

## 2. API Client Deep Dive

### 2.1 getAnthropicClient: 4 Backends

`getAnthropicClient()` in `services/api/client.ts` is the unified entry point for API access, selecting the backend via environment variables:

```typescript
export async function getAnthropicClient({ apiKey, maxRetries, model, fetchOverride, source }) {
  // Common parameters
  const ARGS = { defaultHeaders, maxRetries, timeout: 600_000, dangerouslyAllowBrowser: true, ... }

  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // 1. AWS Bedrock — AnthropicBedrock SDK
    //    Supports awsRegion / awsAccessKey / awsSecretKey / awsSessionToken
    //    ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION can specify a separate region for Haiku
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    // 2. Azure Foundry — AnthropicFoundry SDK
    //    Supports ANTHROPIC_FOUNDRY_API_KEY or Azure AD DefaultAzureCredential
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // 3. Google Vertex AI — AnthropicVertex SDK
    //    GoogleAuth scopes: cloud-platform
    //    Project ID fallback chain: env variable → credentials file → ANTHROPIC_VERTEX_PROJECT_ID
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }
  // 4. Direct API — Standard Anthropic SDK
  //    apiKey (external) vs authToken (Claude.ai subscribers)
  return new Anthropic({
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber() ? getClaudeAIOAuthTokens()?.accessToken : undefined,
    ...ARGS,
  })
}
```

Key details:
- **maxRetries is set to 0 at the SDK layer for all backends**; retry logic is centrally managed by `withRetry.ts`
- **Custom headers**: The `ANTHROPIC_CUSTOM_HEADERS` environment variable injects arbitrary headers (supports HFI debugging scenarios)
- **Proxy support**: `getProxyFetchOptions({ forAnthropicAPI: true })` enables proxying for Anthropic API

### 2.2 Streaming / Non-Streaming Queries

`queryModel` in `services/api/claude.ts` is the core query function. Differences between streaming and non-streaming modes:

**Streaming mode** (primary path):
```typescript
// claude.ts uses withStreamingVCR wrapper in createStream()
for await (const message of withStreamingVCR(messages, async function* () {
  yield* queryModel(messages, /* ... streaming: true */)
}))
```

**Non-streaming fallback**:
- When a streaming request encounters a 529 overloaded error, `withRetry` triggers a `FallbackTriggeredError`
- Falls back to the Sonnet model (`options.fallbackModel`)

### 2.3 Prompt Caching (cache_control)

The `cache_control` marker placement strategy is extremely precise (`claude.ts`):

1. **Only one marker per request**: Mycro's KV page eviction mechanism requires a single `cache_control` marker
2. **Marker placement**: The last content block of the last message
3. **Cache scope**:
   ```typescript
   function getCacheControl({ scope, querySource }): { type: string } {
     // 'global' scope: type = 'ephemeral_1h' (1-hour global cache)
     // default: type = 'ephemeral' (5-minute short-lived cache)
   }
   ```
4. **cache_reference**: Added to `tool_result` blocks before the `cache_control` marker to avoid retransmitting already-cached content
5. **1h cache eligibility**: Dual-gated through GrowthBook feature flag `tengu_prompt_cache_1h` + allowlist

### 2.4 Retry and Degradation Strategy (withRetry.ts)

`withRetry` is an `AsyncGenerator` that can report retry status to the caller via `yield`:

| Error Type | Retry Strategy | Degradation Strategy |
|---------|---------|---------|
| 401 Unauthorized | Refresh OAuth token / API key cache | Rebuild client instance |
| 403 Token Revoked | `handleOAuth401Error` forced refresh | Same as 401 |
| 429 Rate Limit | Exponential backoff (base 500ms, max 32s) | Fast mode: switch to standard speed |
| 529 Overloaded | Up to 3 retries then `FallbackTriggeredError` | Opus to Sonnet model degradation |
| 400 Context Overflow | Adjust `maxTokensOverride` | Retain >= 3000 output tokens |
| AWS/GCP Auth Error | Retry after clearing credential cache | Rebuild client |
| ECONNRESET/EPIPE | Retry after `disableKeepAlive()` | Disable connection pooling |

**Persistent Retry mode** (`CLAUDE_CODE_UNATTENDED_RETRY`):
- For unattended scenarios, 429/529 errors trigger **infinite retries**
- Backoff cap of 5 minutes, reset window cap of 6 hours
- Sends heartbeat every 30 seconds (SystemAPIErrorMessage yield) to prevent the session from being marked idle

**Fast Mode degradation**:
- Short retry-after (<20s): Keep retrying in fast mode (protects prompt cache)
- Long retry-after (>=20s): Enter cooldown period (at least 10 minutes), switch to standard speed

---

## 3. OAuth PKCE Complete Flow

### 3.1 Standard MCP OAuth Flow (auth.ts: performMCPOAuthFlow)

```
User initiates /mcp authentication
       │
       ▼
[1] Check oauth.xaa → yes → go to XAA flow (see next section)
       │ no
       ▼
[2] clearServerTokensFromLocalStorage (clear old tokens)
       │
       ▼
[3] fetchAuthServerMetadata
    RFC 9728 PRM → authorization_servers[0] → RFC 8414 AS metadata
    Fallback: RFC 8414 directly on MCP URL (path-aware)
       │
       ▼
[4] new ClaudeAuthProvider(serverName, serverConfig, redirectUri)
       │
       ▼
[5] Start local HTTP server (127.0.0.1:{port}/callback)
    - port: oauth.callbackPort or findAvailablePort()
    - Listens for code + state parameters
       │
       ▼
[6] sdkAuth() → open authorization URL in browser (PKCE: code_challenge_method=S256)
       │
       ▼
[7] User authorizes in browser → callback to localhost
    - Verify state to prevent CSRF
    - Extract authorization code
       │
       ▼
[8] sdkAuth() exchanges code → tokens (access_token + refresh_token)
       │
       ▼
[9] ClaudeAuthProvider.saveTokens() → keychain (SecureStorage)
    Storage structure: mcpOAuth[serverKey] = {
      serverName, serverUrl, accessToken, refreshToken,
      expiresAt, scope, clientId, clientSecret, discoveryState
    }
```

### 3.2 Token Refresh

`ClaudeAuthProvider` implements the `OAuthClientProvider` interface, and its `tokens()` method is called with every MCP request:

```
ClaudeAuthProvider.tokens()
    │
    ├── Check if accessToken is expired
    │   ├── Not expired → return { access_token, refresh_token }
    │   └── Expired → _doRefresh()
    │       ├── fetchAuthServerMetadata() → get token_endpoint
    │       ├── sdkRefreshAuthorization() → POST /token (grant_type=refresh_token)
    │       ├── Success → saveTokens() → return new tokens
    │       └── Failure →
    │           ├── invalid_grant → invalidateCredentials('tokens') + delete old token
    │           ├── 5xx/transient → retry up to 2 times, 2s interval
    │           └── Other → throw error, mark needs-auth
    │
    └── XAA path: xaaRefresh()
        ├── Check IdP id_token cache
        ├── performCrossAppAccess() (no browser popup)
        └── Save new tokens
```

### 3.3 Step-Up Authentication

```typescript
// auth.ts: wrapFetchWithStepUpDetection
export function wrapFetchWithStepUpDetection(baseFetch, provider): FetchLike {
  return async (url, init) => {
    const response = await baseFetch(url, init)
    if (response.status === 403) {
      const wwwAuth = response.headers.get('WWW-Authenticate')
      // Parse scope and resource_metadata parameters
      // Persist to keychain (stepUpScope + discoveryState.resourceMetadataUrl)
      // Set forceReauth → tokens() next time omits refresh_token → triggers PKCE re-authorization
    }
    return response
  }
}
```

---

## 4. MCP OAuth XAA (Cross-App Access)

### 4.1 Architecture Overview

XAA (Cross-App Access / SEP-990) implements the capability of **one IdP login, silent authentication for N MCP servers**. The core implementation resides in `xaa.ts` and `xaaIdpLogin.ts`.

### 4.2 Complete XAA Flow

```
[Config] settings.xaaIdp = { issuer, clientId, callbackPort? }
[Config] server.oauth = { clientId, xaa: true }
[Config] keychain: mcpOAuthClientConfig[serverKey].clientSecret

performMCPXaaAuth(serverName, serverConfig)
    │
    ▼
[1] acquireIdpIdToken(idpIssuer, idpClientId)
    ├── getCachedIdpIdToken() → cache hit → return directly
    └── Cache miss →
        ├── discoverOidc(issuer) → .well-known/openid-configuration
        ├── startAuthorization() (PKCE: code_challenge_method=S256)
        ├── openBrowser(authorizationUrl) ← the only browser popup
        ├── waitForCallback(port, state, abortSignal)
        ├── exchangeAuthorization() → { id_token, access_token, ... }
        └── saveIdpIdToken(issuer, id_token, expiresAt) → keychain
    │
    ▼
[2] performCrossAppAccess(serverUrl, xaaConfig)
    │
    ├── [Layer 2] discoverProtectedResource(serverUrl) → RFC 9728 PRM
    │   Validation: prm.resource === serverUrl (mix-up protection)
    │
    ├── [Layer 2] discoverAuthorizationServer(asUrl) → RFC 8414
    │   Validation: meta.issuer === asUrl (mix-up protection)
    │   Validation: token_endpoint must be HTTPS
    │   Check: grant_types_supported includes jwt-bearer
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
          Authentication method: client_secret_basic (default) or client_secret_post
    │
    ▼
[3] Save tokens to keychain (mcpOAuth[serverKey])
    Includes discoveryState.authorizationServerUrl for subsequent refreshes
```

### 4.3 Fine-Grained XAA Error Handling Classification

```typescript
// XaaTokenExchangeError carries a shouldClearIdToken flag
// 4xx / invalid_grant → id_token is invalid, clear cache
// 5xx → IdP is down, id_token may still be valid, retain
// 200 + invalid body → protocol violation, clear
```

XAA applies strict redaction for sensitive information (tokens, assertions, client_secret) in logs:

```typescript
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g
function redactTokens(raw) {
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}
```

---

## 5. MCP Configuration System (config.ts)

### 5.1 Configuration Scopes

```typescript
export type ConfigScope = 'local' | 'user' | 'project' | 'dynamic' | 'enterprise' | 'claudeai' | 'managed'
```

Configuration loading priority (`getAllMcpConfigs`):
1. **Enterprise** (`managed-mcp.json`): Disables claude.ai connectors when present
2. **User** (`mcpServers` in `~/.claude/settings.json`)
3. **Project** (`.mcp.json` or `.claude/settings.local.json`)
4. **Plugin**: Provided via `getPluginMcpServers()`
5. **Claude.ai**: Fetched via `fetchClaudeAIMcpConfigsIfEligible()` API
6. **Dynamic**: Injected at runtime (SDK, etc.)

### 5.2 Deduplication Strategy

Three layers of deduplication prevent duplicate connections to the same MCP server:

```typescript
// 1. Plugin vs manual config deduplication
dedupPluginMcpServers(pluginServers, manualServers)
// Signature comparison: stdio → "stdio:" + JSON(commandArray)
//                       remote → "url:" + unwrapCcrProxyUrl(url)

// 2. Claude.ai connector vs manual config deduplication
dedupClaudeAiMcpServers(claudeAiServers, manualServers)
// Only uses enabled manual servers as dedup targets

// 3. CCR proxy URL unwrapping
unwrapCcrProxyUrl(url) // Extracts original vendor URL from mcp_url query parameter
```

### 5.3 Enterprise Policies (Allowlist / Denylist)

```typescript
// Denylist takes absolute priority — three matching methods
isMcpServerDenied(name, config)
  ├── isMcpServerNameEntry(entry)    // by name
  ├── isMcpServerCommandEntry(entry) // by command array (stdio)
  └── isMcpServerUrlEntry(entry)     // by URL wildcard pattern

// Allowlist — uses only policySettings when allowManagedMcpServersOnly is set
isMcpServerAllowedByPolicy(name, config)
```

---

## 6. Plugin Architecture

### 6.1 Directory Structure

```
services/plugins/
  PluginInstallationManager.ts  — Background installation manager
  pluginOperations.ts           — CRUD operations
  pluginCliCommands.ts          — CLI command interface
```

### 6.2 Marketplace and Plugin Lifecycle

```
On startup:
  loadAllPluginsCacheOnly()     ← Load from cache only (non-blocking startup)
Background:
  performBackgroundPluginInstallations()
    ├── getDeclaredMarketplaces()     → marketplaces declared in settings
    ├── loadKnownMarketplacesConfig() → materialized marketplace config
    ├── diffMarketplaces()            → compute missing / sourceChanged
    └── reconcileMarketplaces()       → clone/update Git repos
        └── onProgress: installing → installed | failed

After installation:
  ├── refreshActivePlugins() → reload plugins
  └── or needsRefresh → display notification prompting /reload-plugins
```

### 6.3 How Plugins Provide MCP Servers

Plugins inject MCP server configurations via `getPluginMcpServers()`. Plugin servers are namespaced as `plugin:<name>:<server>`, which avoids key collisions with manual configurations. However, content deduplication (`dedupPluginMcpServers`) detects duplicates with the same command/url.

Each plugin MCP server configuration carries a `pluginSource` field (e.g., `'slack@anthropic'`), used for fast lookup during channel permission control without waiting for the async `AppState.plugins.enabled` to finish loading.

---

## 7. Skills System

### 7.1 Three Sources and Loading Priority

| Source | Directory | LoadedFrom | Loading Timing |
|-----|------|-----------|---------|
| **Bundled** | `skills/bundled/` | `'bundled'` | `initBundledSkills()` registered synchronously at startup |
| **Disk** | `.claude/skills/`, `~/.claude/skills/` | `'skills'` | `loadSkillsDir()` scans Markdown files |
| **MCP** | Remote MCP server prompts | `'mcp'` | `fetchMcpSkillsForClient()` fetched on connection |

### 7.2 Bundled Skill Registration

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

`registerBundledSkill` converts `BundledSkillDefinition` into a `Command` object and pushes it into the global `bundledSkills` array. It supports the `files` field for lazy extraction to disk (`getBundledSkillExtractDir`), using `O_NOFOLLOW|O_EXCL` flags to prevent symlink attacks.

### 7.3 Write-Once Registry Pattern (mcpSkillBuilders.ts)

```typescript
// mcpSkillBuilders.ts — Dependency graph leaf node, no imports
export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b  // write once
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) throw new Error('MCP skill builders not registered')
  return builders
}
```

This pattern solves the circular dependency problem: `client.ts → mcpSkills.ts → loadSkillsDir.ts → ... → client.ts`. By deferring builder registration to module initialization time (`loadSkillsDir.ts` is eagerly evaluated at startup through the static import of `commands.ts`), it ensures builders are ready when MCP servers connect.

### 7.4 Markdown Skill File Format

```markdown
---
description: Skill description text
when-to-use: Trigger condition description
argument-hint: Argument hints
allowed-tools: Bash, Read, Edit
model: claude-sonnet-4-20250514
context: inline | fork
hooks:
  preToolUse:
    - pattern: "*"
      command: echo "pre-hook"
---

# Skill Prompt Content

Actual system prompt text...
```

Frontmatter is parsed by `parseFrontmatter()`, supporting:
- `allowed-tools`: Restricts the list of tools available to the skill
- `model`: Overrides the default model
- `context: fork`: Runs in a sub-agent
- `hooks`: Skill-level pre/post hooks

---

## 8. MCPTool Integration

### 8.1 MCPTool Definition (tools/MCPTool/MCPTool.ts)

```typescript
export const MCPTool = buildTool({
  isMcp: true,
  name: 'mcp',  // Overridden in client.ts to the actual MCP tool name
  maxResultSizeChars: 100_000,
  // description, prompt, call, userFacingName are all overridden in client.ts
  async checkPermissions(): Promise<PermissionResult> {
    return { behavior: 'passthrough', message: 'MCPTool requires permission.' }
  },
})
```

MCPTool is a **template object**. In `fetchToolsForClient()` in `client.ts`, a customized copy is created for each tool exposed by an MCP server, setting:
- `name`: `mcp__{normalizedServerName}__{normalizedToolName}` (double underscore separated)
- `description`: Truncated to `MAX_MCP_DESCRIPTION_LENGTH = 2048` characters
- `call`: Wraps `client.callTool()` + timeout + result formatting + image processing

### 8.2 Tool Call Chain

```
LLM outputs tool_use(name="mcp__github__create_issue", input={...})
    │
    ▼
MCPTool.call(input)
    │
    ├── Look up corresponding ConnectedMCPServer
    ├── client.callTool({ name: originalToolName, arguments: input })
    │   ├── Timeout: getMcpToolTimeoutMs() defaults to ~27.8 hours
    │   ├── 401 → McpAuthError → mark needs-auth
    │   └── 404 + -32001 → McpSessionExpiredError → clear cache → rebuild connection
    │
    ├── Result processing:
    │   ├── isError: true → McpToolCallError
    │   ├── Images: maybeResizeAndDownsampleImageBuffer()
    │   ├── Large output: truncateMcpContentIfNeeded()
    │   └── Binary: persistBinaryContent() → save to disk
    │
    └── Return formatted text result
```

---

## 9. Channel Notifications (MCP Push Messages)

Channel notifications allow MCP servers (such as Discord/Slack/Telegram bots) to push messages into conversations:

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

Notification processing flow:
1. MCP server sends a `notifications/claude/channel` notification
2. Content is wrapped in a `<channel source="..." chat_id="..." ...>` XML tag
3. Enqueued via `enqueue()` into the message queue
4. `SleepTool`'s `hasCommandsInQueue()` detects the new message, waking up within 1 second
5. The model sees the `<channel>` tag and decides how to respond

Permission security: `ChannelPermissionNotificationSchema` supports structured permission replies (`{request_id, behavior}`), preventing text messages from accidentally matching permission confirmations.

---

## 10. Other Key Utility Modules

### 10.1 officialRegistry.ts
```typescript
// Prefetch Anthropic's official MCP registry
export async function prefetchOfficialMcpUrls(): Promise<void> {
  // GET https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial
  // Used by isOfficialMcpUrl() — affects trust level and UI display
}
```

### 10.2 normalization.ts
```typescript
// MCP name normalization: ^[a-zA-Z0-9_-]{1,64}$
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith('claude.ai ')) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  }
  return normalized
}
```

### 10.3 headersHelper.ts
Dynamic header injection mechanism -- generates headers by executing external scripts:
- `headersHelper` in project/local settings must pass trust checks
- Scripts are executed with a timeout, and results are parsed as JSON objects
- Merged with static `headers` and used for all MCP requests

### 10.4 envExpansion.ts
Environment variable expansion: `${VAR}` style references in MCP configurations are expanded to actual values at connection time.

### 10.5 elicitationHandler.ts
MCP servers can collect information from users via the Elicitation protocol:
- **Form mode**: Structured forms
- **URL mode**: Redirect to an external URL and wait for a completion notification
- Asynchronous completion notification via `ElicitationCompleteNotification`

---

## Summary

Claude Code's MCP integration is a complete protocol client implementation, encompassing 8 transport types, a full OAuth/XAA authentication chain, enterprise-grade policy controls, and resilient retry mechanisms. The API client unifies access across 4 cloud backends, with prompt caching strategies providing fine-grained control at the token level. The skills system converges from three sources -- bundled + disk + MCP -- with the write-once registry pattern elegantly solving the circular dependency problem. The plugin system uses marketplaces as distribution units, with background installation that never blocks startup.
