# Decode Claude Code - Architecture Deep Dive

**Claude Code v2.1.88 source architecture analysis — 12 chapters, 8,400+ lines of in-depth analysis.**

## What is this?

On March 31, 2026, Anthropic shipped `@anthropic-ai/claude-code@2.1.88` with a 59.8MB source map (`cli.js.map`) still in the npm package. That file contained the complete, unobfuscated TypeScript source — 1,906 files, 515,029 lines of code.

This project is a structured, chapter-by-chapter architecture analysis of how Claude Code works and why it was designed this way. It covers the full stack: from startup optimization to the agent loop, system prompt design, tool system, security model, multi-agent coordination, and hidden features.

## Read Online

**[View the full analysis](https://0xE1337.github.io/decode-claude-code-analysis/)**

## Chapters

| # | Chapter | Key Focus |
|---|---------|-----------|
| 00 | [Entry & Startup](docs/00-entry-startup.md) | 4-stage boot, 10 optimization strategies, import-time I/O parallelism |
| 01 | [Agent Loop](docs/01-agent-loop.md) | 3-layer AsyncGenerator, 7 continue sites, while(tool_call) philosophy |
| 02 | [System Prompt](docs/02-system-prompt.md) | Static/dynamic zones, 92% cache hit rate, ant vs external diffs |
| 03 | [Tool System](docs/03-tool-system.md) | 40+ tools, buildTool() fail-closed factory, BashTool 18-file engine |
| 04 | [Commands](docs/04-commands.md) | 80+ slash commands, 3 types, prompt command injection pattern |
| 05 | [Context Management](docs/05-context-management.md) | 200K/1M tokens, 3-tier compression, circuit breaker |
| 06 | [Permission & Security](docs/06-permission-security.md) | 17,885 lines, 23 Bash validators, dual-engine AST, real attack vectors |
| 07 | [Multi-Agent](docs/07-multi-agent.md) | 3 modes, fork agent cache sharing, coordinator philosophy |
| 08 | [MCP & Services](docs/08-mcp-services.md) | 8 transports, 4 API backends, OAuth PKCE + XAA |
| 09 | [UI Components](docs/09-ui-components.md) | 389 components, custom Ink fork, REPL.tsx god component |
| 10 | [Feature Flags](docs/10-feature-flags.md) | 88 build-time flags, KAIROS, Buddy pet, Undercover mode |
| 11 | [Infrastructure](docs/11-infrastructure.md) | Task system, 35-line Store, Vim mode, model evolution |

## Key Numbers

| Metric | Value |
|--------|-------|
| Source files analyzed | 1,906 |
| Lines of code | 515,029 |
| Built-in tools | 40+ |
| Slash commands | 80+ |
| Feature flags | 88 (build-time) |
| Security code | ~17,885 lines |
| Context window | 200K / 1M tokens |
| Prompt cache hit rate | 92% |

## Build

The HTML document is generated from the Markdown analysis files:

```bash
cd docs
node build.mjs
# Generates index.html (~394 KB) with syntax highlighting, light/dark theme, font controls
```

## Source

Analysis based on source code extracted from [`claude-code-sourcemap`](https://github.com/0xE1337/claude-code-sourcemap).

## Disclaimer

This project is for **educational and research purposes only**. All intellectual property of Claude Code belongs to Anthropic. This repository contains no original source code — only architecture analysis and design commentary.

## License

MIT
