<div align="center">

# Decode Claude Code

### Architecture Deep Dive / 架构深度解析

**Claude Code v2.1.88 — 12 chapters, 8,400+ lines of analysis**

**Claude Code v2.1.88 — 12 章，8,400+ 行深度分析**

[![GitHub Pages](https://img.shields.io/badge/Read_Online-GitHub_Pages-blue)](https://0xE1337.github.io/decode-claude-code-analysis/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

[**English**](#english) | [**中文**](#chinese)

</div>

---

<a id="english"></a>

## What is this?

On March 31, 2026, Anthropic shipped `@anthropic-ai/claude-code@2.1.88` with a 59.8MB source map (`cli.js.map`) still in the npm package. That file contained the complete, unobfuscated TypeScript source — 1,906 files, 515,029 lines of code.

This project is a structured, chapter-by-chapter architecture analysis of **how Claude Code works and why it was designed this way**. It covers the full stack: from startup optimization to the agent loop, system prompt design, tool system, security model, multi-agent coordination, and hidden features.

### Read Online

**[View the full analysis on GitHub Pages](https://0xE1337.github.io/decode-claude-code-analysis/)**

Features: syntax highlighting, light/dark theme toggle, adjustable font size.

### Chapters

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

### Key Numbers

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

### Build

```bash
cd docs
node build.mjs
# Generates index.html (~394 KB)
```

### Source

Analysis based on source code extracted from [`claude-code-sourcemap`](https://github.com/0xE1337/claude-code-sourcemap).

### Disclaimer

This project is for **educational and research purposes only**. All intellectual property of Claude Code belongs to Anthropic. This repository contains no original source code — only architecture analysis and design commentary.

---

<a id="chinese"></a>

## 这个项目是什么？

2026 年 3 月 31 日，Anthropic 发布的 `@anthropic-ai/claude-code@2.1.88` npm 包中包含了一个 **59.8MB 的 source map 文件**（`cli.js.map`）。该文件内含完整的、未混淆的 TypeScript 源码 — 1,906 个文件，515,029 行代码。

本项目是一份结构化的、逐章节的架构分析，回答的核心问题是：**Claude Code 怎么工作、为什么这样设计**。覆盖完整技术栈：从启动优化到 Agent 循环、System Prompt 设计、工具系统、安全模型、多 Agent 协作到隐藏功能。

### 在线阅读

**[在 GitHub Pages 上阅读完整分析](https://0xE1337.github.io/decode-claude-code-analysis/)**

支持：代码语法高亮、明暗主题切换、字体大小调节。

### 章节目录

| # | 章节 | 核心内容 |
|---|------|----------|
| 00 | [入口与启动优化](docs/00-entry-startup.md) | 4 阶段启动、10 项优化策略、import 期间并行 I/O |
| 01 | [Agent Loop 核心循环](docs/01-agent-loop.md) | 3 层 AsyncGenerator、7 个 continue 站点、while(tool_call) 哲学 |
| 02 | [System Prompt 设计](docs/02-system-prompt.md) | 静态/动态分区、92% 缓存命中率、内外用户差异 |
| 03 | [工具系统](docs/03-tool-system.md) | 40+ 工具、buildTool() fail-closed 工厂、BashTool 18 文件引擎 |
| 04 | [命令系统](docs/04-commands.md) | 80+ 斜杠命令、3 种类型、Prompt 命令注入模式 |
| 05 | [上下文管理](docs/05-context-management.md) | 200K/1M tokens、三层递进压缩、熔断器保护 |
| 06 | [权限与安全](docs/06-permission-security.md) | 17,885 行安全代码、23 个 Bash 验证器、双引擎 AST、真实攻击向量 |
| 07 | [多 Agent 协作](docs/07-multi-agent.md) | 3 种模式、Fork Agent 缓存共享、Coordinator 哲学 |
| 08 | [MCP 与服务层](docs/08-mcp-services.md) | 8 种传输、4 种 API 后端、OAuth PKCE + XAA |
| 09 | [UI 组件系统](docs/09-ui-components.md) | 389 个组件、自定义 Ink fork、REPL.tsx 上帝组件 |
| 10 | [Feature Flags](docs/10-feature-flags.md) | 88 个构建时 Flag、KAIROS 助理模式、Buddy 电子宠物、Undercover 卧底模式 |
| 11 | [基础设施](docs/11-infrastructure.md) | Task 系统、35 行 Store、Vim 模式、模型演进追踪 |

### 核心数据

| 指标 | 数值 |
|------|------|
| 分析的源文件数 | 1,906 |
| 代码行数 | 515,029 |
| 内置工具 | 40+ |
| 斜杠命令 | 80+ |
| Feature Flags | 88（构建时） |
| 安全代码 | ~17,885 行 |
| 上下文窗口 | 200K / 1M tokens |
| Prompt Cache 命中率 | 92% |

### 构建

```bash
cd docs
node build.mjs
# 生成 index.html（~394 KB）
```

### 数据来源

基于 [`claude-code-sourcemap`](https://github.com/0xE1337/claude-code-sourcemap) 提取的源码进行分析。

### 声明

本项目仅用于**教育和研究目的**。Claude Code 的所有知识产权归 Anthropic 所有。本仓库不包含任何原始源码，仅包含架构分析和设计解读。

---

<div align="center">

**License: MIT**

</div>
