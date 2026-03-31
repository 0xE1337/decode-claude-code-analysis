#!/usr/bin/env node
/**
 * Build script: reads all 12 MD analysis files and generates a comprehensive
 * bilingual HTML document with theme toggle, language toggle, and SVG diagrams.
 *
 * Usage: node build.mjs
 * Output: index.html
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const DIR = import.meta.dirname || '.';

// ── Tiny Markdown-to-HTML converter (no deps) ──
// Returns { html, toc } where toc is a list of {level, id, text}
let headingCounter = 0;
function md2html(md, prefix) {
  let html = md;
  const toc = [];
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escHtml(code.trimEnd());
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${escaped}</code></pre>`;
  });
  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm, (_, hdr, sep, body) => {
    const ths = hdr.split('|').filter(Boolean).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(r => {
      const tds = r.split('|').filter(Boolean).map(c => `<td>${inlineMarkdown(c.trim())}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('\n');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  // Split into lines for block processing
  const lines = html.split('\n');
  const out = [];
  let inList = false;
  let listType = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Skip if already processed (pre/table)
    if (line.startsWith('<pre>') || line.startsWith('<table>')) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push(line);
      continue;
    }
    // Headers — add id for TOC
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      const level = hMatch[1].length;
      const text = inlineMarkdown(hMatch[2]);
      const plain = hMatch[2].replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
      const id = `${prefix}-h${++headingCounter}`;
      toc.push({ level, id, text: plain });
      out.push(`<h${level + 1} id="${id}">${text}</h${level + 1}>`);
      continue;
    }
    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      if (!inList || listType !== 'ul') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ul>'); inList = true; listType = 'ul';
      }
      out.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      if (!inList || listType !== 'ol') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ol>'); inList = true; listType = 'ol';
      }
      out.push(`<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push('<hr/>');
      continue;
    }
    // Blank line
    if (line.trim() === '') {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      continue;
    }
    // Paragraph
    if (inList) { out.push(`</${listType}>`); inList = false; }
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inList) out.push(`</${listType}>`);
  return { html: out.join('\n'), toc };
}

function buildTocHtml(toc) {
  if (toc.length < 3) return '';
  // Only show the top-level headings (## sections), not sub-details
  const minLevel = Math.min(...toc.map(t => t.level));
  const major = toc.filter(t => t.level === minLevel);
  if (major.length < 2) return '';
  const items = major
    .map(t => `<a href="#${t.id}" class="toc-l1">${t.text}</a>`)
    .join('\n');
  return `<nav class="ch-toc">${items}</nav>`;
}

function inlineMarkdown(s) {
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Load MD files (CN + EN) ──
const cnFiles = readdirSync(DIR)
  .filter(f => f.endsWith('.md') && /^\d{2}-/.test(f) && !f.endsWith('-en.md'))
  .sort();

const chapters = cnFiles.map(f => {
  const raw = readFileSync(join(DIR, f), 'utf-8');
  const num = f.slice(0, 2);
  const titleMatch = raw.match(/^#\s+(.+)/m);
  const titleCn = titleMatch ? titleMatch[1].replace(/^\d+\s*-\s*/, '') : f;
  const bodyCn = raw.replace(/^#\s+.+\n+/, '');
  const cn = md2html(bodyCn, `${num}-cn`);

  // Load English version
  const enFile = f.replace(/\.md$/, '-en.md');
  let titleEn = titleCn, en = { html: cn.html, toc: cn.toc };
  try {
    const rawEn = readFileSync(join(DIR, enFile), 'utf-8');
    const enTitleMatch = rawEn.match(/^#\s+(.+)/m);
    titleEn = enTitleMatch ? enTitleMatch[1].replace(/^\d+\s*-\s*/, '') : titleCn;
    const bodyEn = rawEn.replace(/^#\s+.+\n+/, '');
    en = md2html(bodyEn, `${num}-en`);
  } catch {}

  return { num, titleCn, titleEn, id: `ch${num}`, file: f,
    htmlCn: cn.html, htmlEn: en.html, tocCn: cn.toc, tocEn: en.toc };
});

// ── SVG Diagrams per chapter ──
const diagrams = {
  'ch00': `<svg width="840" height="100" viewBox="0 0 840 100">
    <rect x="20" y="20" width="160" height="55" class="svg-box-a"/><text x="45" y="48" class="st st-t">cli.tsx</text><text x="42" y="64" class="st st-s">Fast-path dispatch</text>
    <line x1="180" y1="47" x2="210" y2="47" class="arr-a"/>
    <rect x="212" y="20" width="160" height="55" class="svg-box-a"/><text x="238" y="48" class="st st-t">main.tsx</text><text x="228" y="64" class="st st-s">4,683 lines / I/O prefetch</text>
    <line x1="372" y1="47" x2="402" y2="47" class="arr-a"/>
    <rect x="404" y="20" width="160" height="55" class="svg-box-a"/><text x="445" y="48" class="st st-t">init.ts</text><text x="428" y="64" class="st st-s">Subsystem init</text>
    <line x1="564" y1="47" x2="594" y2="47" class="arr-a"/>
    <rect x="596" y="20" width="160" height="55" class="svg-box-a"/><text x="628" y="48" class="st st-t">setup.ts</text><text x="618" y="64" class="st st-s">Auth + Prefetch</text>
  </svg>`,
  'ch01': `<svg width="840" height="230" viewBox="0 0 840 230">
    <rect x="20" y="10" width="800" height="50" class="svg-box-a"/><text x="40" y="38" class="st st-t">QueryEngine.submitMessage()</text><text x="340" y="38" class="st st-s">Session-level: messages, usage, permissions</text>
    <rect x="50" y="72" width="740" height="50" class="svg-box-g"/><text x="70" y="100" class="st st-t">queryLoop() — while(true)</text><text x="350" y="100" class="st st-s">7 continue sites, State per iteration</text>
    <rect x="80" y="134" width="680" height="50" class="svg-box-p"/><text x="100" y="162" class="st st-t">deps.callModel() — Streaming</text><text x="400" y="162" class="st st-s">StreamingToolExecutor parallel</text>
    <text x="20" y="215" class="st st-s">Flow: Preprocess → 5-Layer Compress → Call API → Parse → Execute Tools → more? → loop / done</text>
  </svg>`,
  'ch02': `<svg width="840" height="180" viewBox="0 0 840 180">
    <rect x="20" y="10" width="390" height="100" class="svg-box-g"/><text x="40" y="35" fill="var(--green)" class="st" style="font-size:14px;font-weight:700">STATIC (Cached Globally)</text>
    <text x="40" y="58" class="st st-s">7 sections: Identity, Rules, Tasks, Actions, Tools, Tone, Output</text>
    <text x="40" y="78" class="st st-s">~2,000-4,500 tokens | cacheScope: 'global'</text>
    <text x="40" y="98" class="st st-s">Shared across ALL users</text>
    <rect x="20" y="115" width="390" height="22" rx="0" fill="rgba(248,81,73,.15)" stroke="var(--red)" stroke-width="2" stroke-dasharray="5,3"/>
    <text x="35" y="131" fill="var(--red)" style="font-family:monospace;font-size:11px">__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__</text>
    <rect x="20" y="142" width="390" height="35" class="svg-box-o"/><text x="40" y="164" fill="var(--orange)" class="st" style="font-size:13px;font-weight:600">DYNAMIC (Not Cached)</text>
    <text x="260" y="164" class="st st-s">12+ sections per session</text>
    <rect x="440" y="10" width="380" height="80" class="svg-box-a"/><text x="460" y="35" class="st st-t">Cache Strategy</text>
    <text x="460" y="55" class="st st-s">92% hit rate | 4 cache_control positions</text>
    <text x="460" y="75" class="st st-s">10.2% disaster fixed (agent_listing_delta)</text>
    <rect x="440" y="100" width="380" height="75" class="svg-box-p"/><text x="460" y="125" class="st st-t">ant vs External (12 diffs)</text>
    <text x="460" y="145" class="st st-s">External: concise. Internal: verbose, challenging</text>
    <text x="460" y="165" class="st st-s">Build-time DCE: ant code physically absent</text>
  </svg>`,
  'ch05': `<svg width="840" height="80" viewBox="0 0 840 80">
    <rect x="20" y="15" width="145" height="45" class="svg-box-g"/><text x="38" y="42" class="st st-s">Micro (Free)</text>
    <line x1="165" y1="37" x2="188" y2="37" class="arr"/>
    <rect x="190" y="15" width="175" height="45" class="svg-box-o"/><text x="210" y="42" class="st st-s">Session Memory (1 API)</text>
    <line x1="365" y1="37" x2="388" y2="37" class="arr"/>
    <rect x="390" y="15" width="175" height="45" class="svg-box-r"/><text x="412" y="42" class="st st-s">Full Compact (1 API, 20K)</text>
    <line x1="565" y1="37" x2="588" y2="37" class="arr"/>
    <rect x="590" y="15" width="165" height="45" rx="8" fill="rgba(248,81,73,.06)" stroke="var(--red)" stroke-width="1.5"/><text x="610" y="42" fill="var(--red)" class="st" style="font-size:12px;font-weight:600">Circuit Breaker (3x)</text>
  </svg>`,
  'ch06': `<svg width="840" height="90" viewBox="0 0 840 90">
    <rect x="20" y="15" width="120" height="45" class="svg-box-a"/><text x="35" y="42" class="st st-s">Command</text>
    <line x1="140" y1="37" x2="165" y2="37" class="arr"/>
    <rect x="167" y="15" width="120" height="45" class="svg-box-p"/><text x="185" y="42" class="st st-s">AST Parse</text>
    <line x1="287" y1="37" x2="312" y2="37" class="arr"/>
    <rect x="314" y="15" width="140" height="45" class="svg-box-o"/><text x="328" y="42" class="st st-s">23 Validators</text>
    <line x1="454" y1="37" x2="479" y2="37" class="arr"/>
    <polygon points="535,15 585,37 535,60 485,37" fill="rgba(63,185,80,.08)" stroke="var(--green)" stroke-width="1.5"/>
    <text x="514" y="41" class="st st-s">Safe?</text>
    <line x1="585" y1="30" x2="630" y2="30" stroke="var(--green)" stroke-width="1.5" marker-end="url(#ah-g)"/><text x="635" y="34" fill="var(--green)" class="st" style="font-size:11px">Execute</text>
    <line x1="535" y1="60" x2="535" y2="78" stroke="var(--red)" stroke-width="1.5" marker-end="url(#ah-r)"/><text x="515" y="88" fill="var(--red)" class="st" style="font-size:11px">Ask User</text>
  </svg>`,
  'ch03': `<svg width="840" height="115" viewBox="0 0 840 115">
    <text x="20" y="18" class="st st-l">Tool Lifecycle</text>
    <rect x="20" y="28" width="110" height="40" class="svg-box-a"/><text x="35" y="52" class="st st-s">buildTool()</text>
    <line x1="130" y1="48" x2="152" y2="48" class="arr"/>
    <rect x="154" y="28" width="110" height="40" class="svg-box-g"/><text x="165" y="52" class="st st-s">Feature Filter</text>
    <line x1="264" y1="48" x2="286" y2="48" class="arr"/>
    <rect x="288" y="28" width="100" height="40" class="svg-box"/><text x="305" y="52" class="st st-s">Tool Pool</text>
    <line x1="388" y1="48" x2="410" y2="48" class="arr"/>
    <rect x="412" y="28" width="120" height="40" class="svg-box-p"/><text x="422" y="52" class="st st-s">Permission Check</text>
    <line x1="532" y1="48" x2="554" y2="48" class="arr"/>
    <rect x="556" y="28" width="100" height="40" class="svg-box-o"/><text x="576" y="52" class="st st-s">Execute</text>
    <line x1="656" y1="48" x2="678" y2="48" class="arr"/>
    <rect x="680" y="28" width="100" height="40" class="svg-box-r"/><text x="698" y="52" class="st st-s">Result</text>
    <text x="20" y="98" class="st st-s">Fail-closed: isReadOnly defaults false | isConcurrencySafe defaults false | ToolSearch deferred loading (7-level chain)</text>
  </svg>`,
  'ch04': `<svg width="840" height="100" viewBox="0 0 840 100">
    <text x="20" y="18" class="st st-l">3 Command Types</text>
    <rect x="20" y="30" width="240" height="50" class="svg-box-a"/><text x="40" y="52" class="st st-t">local</text><text x="40" y="68" class="st st-s">Direct execution (/clear, /help)</text>
    <rect x="280" y="30" width="240" height="50" class="svg-box-g"/><text x="300" y="52" class="st st-t">local-jsx</text><text x="300" y="68" class="st st-s">React/Ink UI render (/config)</text>
    <rect x="540" y="30" width="260" height="50" class="svg-box-p"/><text x="560" y="52" class="st st-t">prompt</text><text x="560" y="68" class="st st-s">Inject into conversation (/commit)</text>
    <text x="20" y="98" class="st st-s">6 sources: bundled | builtinPlugin | skillDir | workflow | plugin | builtin &mdash; 80+ commands, ~28 internal-only</text>
  </svg>`,
  'ch07': `<svg width="840" height="140" viewBox="0 0 840 140">
    <text x="20" y="18" class="st st-l">3 Collaboration Modes + 3 Isolation Levels</text>
    <rect x="20" y="30" width="250" height="45" class="svg-box-a"/><text x="40" y="50" class="st st-t">Sub-Agent</text><text x="40" y="65" class="st st-s">Default, 6 modes (fg/bg/fork/wt/remote/tm)</text>
    <rect x="290" y="30" width="250" height="45" class="svg-box-g"/><text x="310" y="50" class="st st-t">Coordinator</text><text x="310" y="65" class="st st-s">"Never delegate understanding"</text>
    <rect x="560" y="30" width="250" height="45" class="svg-box-p"/><text x="580" y="50" class="st st-t">Team / Swarm</text><text x="580" y="65" class="st st-s">tmux or in-process parallel</text>
    <rect x="20" y="90" width="250" height="40" class="svg-box"/><text x="40" y="115" class="st st-s">No Isolation (shared fs)</text>
    <line x1="270" y1="110" x2="288" y2="110" class="arr"/>
    <rect x="290" y="90" width="250" height="40" class="svg-box-o"/><text x="310" y="115" class="st st-s">Git Worktree (file isolation)</text>
    <line x1="540" y1="110" x2="558" y2="110" class="arr"/>
    <rect x="560" y="90" width="250" height="40" class="svg-box-r"/><text x="580" y="115" class="st st-s">Remote CCR (full isolation)</text>
  </svg>`,
  'ch08': `<svg width="840" height="110" viewBox="0 0 840 110">
    <text x="20" y="18" class="st st-l">MCP Connection Flow</text>
    <rect x="20" y="28" width="140" height="40" class="svg-box-a"/><text x="35" y="52" class="st st-s">8 Transports</text>
    <line x1="160" y1="48" x2="182" y2="48" class="arr"/>
    <rect x="184" y="28" width="150" height="40" class="svg-box-g"/><text x="198" y="52" class="st st-s">Connection Mgr</text>
    <line x1="334" y1="48" x2="356" y2="48" class="arr"/>
    <rect x="358" y="28" width="140" height="40" class="svg-box-p"/><text x="372" y="52" class="st st-s">Tool Discovery</text>
    <line x1="498" y1="48" x2="520" y2="48" class="arr"/>
    <rect x="522" y="28" width="100" height="40" class="svg-box-o"/><text x="542" y="52" class="st st-s">Execute</text>
    <text x="20" y="92" class="st st-s">4 API Backends: Anthropic Direct | AWS Bedrock | Google Vertex | Palantir Foundry &mdash; unified via getAnthropicClient</text>
  </svg>`,
  'ch09': `<svg width="840" height="120" viewBox="0 0 840 120">
    <text x="20" y="18" class="st st-l">UI Architecture Stack</text>
    <rect x="150" y="25" width="540" height="35" class="svg-box-r"/><text x="300" y="48" class="st st-t">REPL.tsx (~6,000 lines, 280+ imports)</text>
    <rect x="150" y="65" width="260" height="30" class="svg-box-a"/><text x="195" y="85" class="st st-s">389+ React Components</text>
    <rect x="420" y="65" width="270" height="30" class="svg-box-g"/><text x="460" y="85" class="st st-s">Custom Ink Fork (dual buffer)</text>
    <rect x="150" y="100" width="540" height="20" rx="4" class="svg-box-p"/><text x="350" y="115" class="st st-s">Yoga Layout &rarr; Terminal (TTY)</text>
  </svg>`,
  'ch10': `<svg width="840" height="110" viewBox="0 0 840 110">
    <text x="20" y="18" class="st st-l">Dual-Layer Feature Flag Architecture</text>
    <rect x="20" y="28" width="380" height="50" class="svg-box-a"/><text x="40" y="50" class="st st-t">Build-Time (88 flags)</text><text x="40" y="66" class="st st-s">bun:bundle feature() macro + DCE</text>
    <rect x="420" y="28" width="380" height="50" class="svg-box-g"/><text x="440" y="50" class="st st-t">Runtime (GrowthBook)</text><text x="440" y="66" class="st st-s">A/B testing + kill-switch + remote eval</text>
    <text x="20" y="100" class="st st-s">Key: KAIROS (assistant) | BUDDY (pet) | UNDERCOVER (stealth) | VOICE_MODE | COORDINATOR | Codename: "Tengu"</text>
  </svg>`,
  'ch11': `<svg width="840" height="90" viewBox="0 0 840 90">
    <text x="20" y="18" class="st st-l">Infrastructure Modules</text>
    <rect x="20" y="30" width="110" height="40" class="svg-box-a"/><text x="33" y="55" class="st st-s">Task (7 types)</text>
    <rect x="140" y="30" width="110" height="40" class="svg-box-g"/><text x="152" y="55" class="st st-s">State (35-line)</text>
    <rect x="260" y="30" width="110" height="40" class="svg-box-p"/><text x="272" y="55" class="st st-s">Migrations</text>
    <rect x="380" y="30" width="100" height="40" class="svg-box-o"/><text x="400" y="55" class="st st-s">Vim FSM</text>
    <rect x="490" y="30" width="110" height="40" class="svg-box-r"/><text x="500" y="55" class="st st-s">Remote/CCR</text>
    <rect x="610" y="30" width="100" height="40" class="svg-box"/><text x="622" y="55" class="st st-s">Keybindings</text>
    <rect x="720" y="30" width="95" height="40" class="svg-box"/><text x="732" y="55" class="st st-s">memdir</text>
  </svg>`,
};

// ── HTML Template ──
const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light" data-lang="cn">
<!-- Language toggle CSS is inline below -->
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code v2.1.88 - Architecture Deep Dive</title>
<!-- highlight.js -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" id="hljs-dark" disabled>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" id="hljs-light">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/languages/typescript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/languages/bash.min.js"></script>
<style>
:root { --t: .25s ease; --fs: 16px; }
[data-theme="dark"] {
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bg4:#30363d;
  --fg:#e6edf3;--fg2:#8b949e;--fg3:#6e7681;
  --accent:#58a6ff;--green:#3fb950;--purple:#d2a8ff;--orange:#f0883e;--red:#f85149;--cyan:#79c0ff;
  --border:#30363d;--code-bg:#0d1117;--card-bg:#161b22;--hover:rgba(88,166,255,.06);
}
[data-theme="light"] {
  --bg:#fff;--bg2:#f6f8fa;--bg3:#eaeef2;--bg4:#d0d7de;
  --fg:#1f2328;--fg2:#656d76;--fg3:#8c959f;
  --accent:#0969da;--green:#1a7f37;--purple:#8250df;--orange:#bc4c00;--red:#cf222e;--cyan:#0550ae;
  --border:#d0d7de;--code-bg:#f6f8fa;--card-bg:#f6f8fa;--hover:rgba(9,105,218,.06);
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.8;font-size:var(--fs);transition:background var(--t),color var(--t)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
/* Language toggle */
[data-lang="cn"] .en{display:none!important}
[data-lang="en"] .cn{display:none!important}
::selection{background:rgba(88,166,255,.3)}

/* Top Bar */
.topbar{position:sticky;top:0;z-index:200;background:var(--bg2);border-bottom:1px solid var(--border);padding:8px 24px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(12px);transition:background var(--t)}
.topbar .logo{font-weight:700;font-size:15px;color:var(--fg)}.topbar .logo span{color:var(--accent)}
.topbar .ctrls{display:flex;gap:8px}
.tbtn{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:4px 14px;font-size:13px;color:var(--fg2);cursor:pointer;transition:all .15s;font-family:inherit}
.tbtn:hover{border-color:var(--accent);color:var(--accent)}

/* Sidebar */
.sidebar{position:fixed;left:0;top:45px;width:250px;height:calc(100vh - 45px);background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;padding:10px 0;transition:background var(--t)}
.sidebar a{display:block;padding:5px 16px;color:var(--fg2);font-size:13px;border-left:3px solid transparent;transition:all .12s}
.sidebar a:hover,.sidebar a.active{color:var(--fg);background:var(--hover);border-left-color:var(--accent);text-decoration:none}
.sidebar .n{color:var(--accent);font-weight:600;font-size:11px;margin-right:5px}

/* Main */
.main{margin-left:250px;padding:0}

/* Hero */
.hero{padding:50px 45px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,var(--bg) 0%,var(--bg2) 100%)}
.hero h1{font-size:34px;color:var(--fg);margin-bottom:6px}.hero h1 span{color:var(--accent)}
.hero .sub{font-size:15px;color:var(--fg2);margin-bottom:20px;max-width:700px}
.stats{display:flex;flex-wrap:wrap;gap:24px}
.stat .v{font-size:24px;font-weight:700;color:var(--accent)}.stat .l{font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.7px}

/* Chapter */
.chapter{padding:40px 45px;border-bottom:1px solid var(--border);transition:background var(--t)}
.chapter:nth-child(even){background:var(--bg2)}
.chapter h2{font-size:24px;color:var(--fg);margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid var(--accent)}
.chapter h3{font-size:18px;color:var(--cyan);margin:24px 0 10px;padding-left:0}
.chapter h4{font-size:15px;color:var(--purple);margin:18px 0 8px}
.chapter h5{font-size:14px;color:var(--orange);margin:14px 0 6px}
.chapter p,.chapter li{color:var(--fg);font-size:var(--fs);margin-bottom:10px;max-width:900px}
.chapter ul,.chapter ol{padding-left:22px;margin-bottom:14px}
.chapter strong{color:var(--fg)}
.chapter hr{border:none;border-top:1px solid var(--border);margin:24px 0}

/* Code — highlight.js handles syntax colors inside pre>code; we style the container */
pre{background:var(--code-bg)!important;border:1px solid var(--border);border-radius:8px;padding:14px 18px;overflow-x:auto;margin:14px 0;font-size:calc(var(--fs) * .85);line-height:1.55;transition:background var(--t)}
pre code{font-family:'SF Mono','Fira Code',Consolas,monospace;font-size:inherit;background:transparent!important;padding:0!important}
code{font-family:'SF Mono','Fira Code',Consolas,monospace;font-size:calc(var(--fs) * .85);color:var(--cyan)}
/* Inline code (not in pre) keeps our custom style */
p code,li code,td code,h3 code,h4 code{background:var(--bg3);padding:1px 5px;border-radius:3px;font-size:calc(var(--fs) * .8);color:var(--cyan)}

/* Tables */
table{border-collapse:collapse;margin:14px 0;width:100%;max-width:900px}
th,td{border:1px solid var(--border);padding:7px 11px;text-align:left;font-size:calc(var(--fs) * .82)}
th{background:var(--bg3);color:var(--fg);font-weight:600}td{color:var(--fg2)}

/* Diagram */
.diagram{margin:20px 0;overflow-x:auto}
.diagram svg{display:block;max-width:100%}
.svg-box{fill:var(--bg3);stroke:var(--border);stroke-width:1.5;rx:8}
.svg-box-a{fill:rgba(88,166,255,.08);stroke:var(--accent);stroke-width:1.5;rx:8}
.svg-box-g{fill:rgba(63,185,80,.08);stroke:var(--green);stroke-width:1.5;rx:8}
.svg-box-p{fill:rgba(210,168,255,.08);stroke:var(--purple);stroke-width:1.5;rx:8}
.svg-box-o{fill:rgba(240,136,62,.08);stroke:var(--orange);stroke-width:1.5;rx:8}
.svg-box-r{fill:rgba(248,81,73,.08);stroke:var(--red);stroke-width:1.5;rx:8}
.st{font-family:-apple-system,sans-serif}.st-t{fill:var(--fg);font-size:14px;font-weight:600}.st-s{fill:var(--fg2);font-size:11px}.st-l{fill:var(--accent);font-size:12px;font-weight:600}
.arr{stroke:var(--fg3);stroke-width:1.5;fill:none;marker-end:url(#ah)}
.arr-a{stroke:var(--accent);stroke-width:2;fill:none;marker-end:url(#ah-a)}

/* Chapter TOC */
.ch-toc{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:24px;columns:2;column-gap:24px}
.ch-toc a{display:block;color:var(--fg2);font-size:calc(var(--fs) * .82);padding:2px 0;break-inside:avoid;transition:color .1s}
.ch-toc a:hover{color:var(--accent);text-decoration:none}
.ch-toc .toc-l1{font-weight:600;color:var(--fg)}
.ch-toc .toc-l2{padding-left:14px}
@media(max-width:800px){.ch-toc{columns:1}}

/* Search */
.search-wrap{position:relative}
.search-wrap input{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:4px 12px 4px 30px;font-size:13px;color:var(--fg);width:200px;font-family:inherit;outline:none;transition:border-color .15s}
.search-wrap input:focus{border-color:var(--accent);width:260px}
.search-wrap input::placeholder{color:var(--fg3)}
.search-wrap svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);pointer-events:none}
.search-results{position:absolute;top:100%;right:0;margin-top:6px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;width:400px;max-height:420px;overflow-y:auto;box-shadow:0 8px 24px var(--hover);display:none;z-index:300}
.search-results.show{display:block}
.search-results .sr-item{display:block;padding:10px 14px;border-bottom:1px solid var(--border);color:var(--fg2);font-size:13px;cursor:pointer;transition:background .1s}
.search-results .sr-item:hover{background:var(--hover);text-decoration:none}
.search-results .sr-item:last-child{border-bottom:none}
.sr-item .sr-ch{color:var(--accent);font-weight:600;font-size:11px}
.sr-item .sr-text{display:block;margin-top:2px}
.sr-item mark{background:rgba(88,166,255,.25);color:var(--fg);border-radius:2px;padding:0 1px}
.search-results .sr-empty{padding:16px;color:var(--fg3);text-align:center;font-size:13px}

.footer{padding:30px 45px;text-align:center;color:var(--fg3);font-size:12px}
@media(max-width:800px){.sidebar{display:none}.main{margin-left:0}.hero,.chapter{padding:20px 16px}.search-wrap input{width:140px}.search-results{width:300px}}
</style>
</head>
<body>
<svg style="position:absolute;width:0;height:0"><defs>
  <marker id="ah" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--fg3)"/></marker>
  <marker id="ah-a" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--accent)"/></marker>
  <marker id="ah-g" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--green)"/></marker>
  <marker id="ah-r" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="var(--red)"/></marker>
</defs></svg>

<div class="topbar">
  <div class="logo">Decode <span>Claude Code</span> v2.1.88</div>
  <div class="ctrls">
    <div class="search-wrap">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--fg3)"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z"/></svg>
      <input type="text" id="searchInput" placeholder="Search..." oninput="onSearch(this.value)"/>
      <div class="search-results" id="searchResults"></div>
    </div>
    <button class="tbtn" onclick="toggleLang()" id="langBtn">EN</button>
    <button class="tbtn" onclick="changeFont(-2)">A-</button>
    <span id="fsLabel" style="color:var(--fg2);font-size:13px;min-width:38px;text-align:center">16px</span>
    <button class="tbtn" onclick="changeFont(2)">A+</button>
    <button class="tbtn" onclick="toggleTheme()" id="themeBtn">Dark</button>
  </div>
</div>

<nav class="sidebar">
  <a href="#overview"><span class="n">--</span>Overview</a>
${chapters.map(c => `  <a href="#${c.id}"><span class="n">${c.num}</span><span class="cn">${c.titleCn.slice(0, 20)}</span><span class="en">${c.titleEn.slice(0, 24)}</span></a>`).join('\n')}
</nav>

<div class="main">
  <div class="hero" id="overview">
    <h1>Decode <span>Claude Code</span></h1>
    <p class="sub cn">1,906 个源文件从 59.8MB source map 完整提取 — 逐模块深度架构分析，覆盖 515,029 行代码的设计哲学、实现细节与工程权衡。</p>
    <p class="sub en">1,906 source files extracted from 59.8MB source map — module-by-module deep architecture analysis covering design philosophy, implementation details and engineering trade-offs across 515,029 lines of code.</p>
    <div class="stats">
      <div class="stat"><div class="v">1,906</div><div class="l">Source Files</div></div>
      <div class="stat"><div class="v">515K</div><div class="l">Lines of Code</div></div>
      <div class="stat"><div class="v">40+</div><div class="l">Tools</div></div>
      <div class="stat"><div class="v">80+</div><div class="l">Commands</div></div>
      <div class="stat"><div class="v">88</div><div class="l">Feature Flags</div></div>
      <div class="stat"><div class="v">200K</div><div class="l">Context Tokens</div></div>
    </div>
  </div>

${chapters.map(c => {
  const diag = diagrams[c.id] || '';
  const diagHtml = diag ? `<div class="diagram">${diag}</div>` : '';
  return `  <div class="chapter" id="${c.id}">
    <h2><span class="cn">${c.num} — ${c.titleCn}</span><span class="en">${c.num} — ${c.titleEn}</span></h2>
    ${diagHtml}
    <div class="cn">${buildTocHtml(c.tocCn)}${c.htmlCn}</div>
    <div class="en">${buildTocHtml(c.tocEn)}${c.htmlEn}</div>
  </div>`;
}).join('\n\n')}

  <div class="footer">
    <p>Claude Code v2.1.88 Source Architecture Analysis — 1,906 files, 515,029 lines</p>
    <p>12 chapters deep analysis &middot; Generated from restored TypeScript source</p>
    <p style="margin-top:8px">For educational and research purposes only. All IP belongs to Anthropic.</p>
  </div>
</div>

<script>
// Syntax highlighting
hljs.highlightAll();

// Language: read from URL param on load, then toggle
(function(){
  const p=new URLSearchParams(location.search).get('lang');
  if(p==='en'||p==='cn'){
    document.documentElement.dataset.lang=p;
    document.getElementById('langBtn').textContent=p==='cn'?'EN':'CN';
  }
})();
function toggleLang(){
  const h=document.documentElement;
  const n=h.dataset.lang==='cn'?'en':'cn';
  h.dataset.lang=n;
  document.getElementById('langBtn').textContent=n==='cn'?'EN':'CN';
  history.replaceState(null,'',location.pathname+'?lang='+n);
}

// Font size
let fs=16;
function changeFont(d){
  fs=Math.max(12,Math.min(24,fs+d));
  document.documentElement.style.setProperty('--fs',fs+'px');
  document.getElementById('fsLabel').textContent=fs+'px';
}

// Theme toggle (also swaps hljs stylesheet)
function toggleTheme(){
  const h=document.documentElement,n=h.dataset.theme==='dark'?'light':'dark';
  h.dataset.theme=n;
  document.getElementById('themeBtn').textContent=n==='dark'?'Light':'Dark';
  document.getElementById('hljs-dark').disabled = n==='light';
  document.getElementById('hljs-light').disabled = n==='dark';
}

// Search
const searchIndex=[];
document.querySelectorAll('.chapter').forEach(ch=>{
  const id=ch.id;
  ch.querySelectorAll('p,li,th,td,h3,h4,h5').forEach(el=>{
    const text=el.textContent.trim();
    if(text.length>5) searchIndex.push({id,text,el});
  });
});
let searchTimer;
function onSearch(q){
  clearTimeout(searchTimer);
  const box=document.getElementById('searchResults');
  if(!q||q.length<2){box.classList.remove('show');box.innerHTML='';return}
  searchTimer=setTimeout(()=>{
    const lang=document.documentElement.dataset.lang;
    const lower=q.toLowerCase();
    const hits=searchIndex.filter(item=>{
      const parent=item.el.closest('.cn,.en');
      if(parent){
        if(lang==='cn'&&parent.classList.contains('en'))return false;
        if(lang==='en'&&parent.classList.contains('cn'))return false;
      }
      return item.text.toLowerCase().includes(lower);
    }).slice(0,20);
    if(hits.length===0){
      box.innerHTML='<div class="sr-empty">No results</div>';
    } else {
      box.innerHTML=hits.map(h=>{
        const i=h.text.toLowerCase().indexOf(lower);
        const start=Math.max(0,i-40);
        const end=Math.min(h.text.length,i+q.length+40);
        let snippet=(start>0?'...':'')+h.text.slice(start,end)+(end<h.text.length?'...':'');
        const esc=q.replace(/[-\/\\^$*+?.()|[\]{}]/g,'\\$&');
        snippet=snippet.replace(new RegExp('('+esc+')','gi'),'<mark>$1</mark>');
        const chNum=h.id.replace('ch','');
        return '<a class="sr-item" href="#'+h.id+'" onclick="closeSearch()"><span class="sr-ch">Ch '+chNum+'</span><span class="sr-text">'+snippet+'</span></a>';
      }).join('');
    }
    box.classList.add('show');
  },150);
}
function closeSearch(){document.getElementById('searchResults').classList.remove('show');document.getElementById('searchInput').value=''}
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))closeSearch()});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.target.closest('input')){e.preventDefault();document.getElementById('searchInput').focus()}if(e.key==='Escape')closeSearch()});

// Sidebar active tracking
const secs=document.querySelectorAll('.chapter,.hero'),links=document.querySelectorAll('.sidebar a');
const obs=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){links.forEach(l=>l.classList.remove('active'));const l=document.querySelector('.sidebar a[href="#'+e.target.id+'"]');if(l)l.classList.add('active')}})},{rootMargin:'-10% 0px -70% 0px'});
secs.forEach(s=>{if(s.id)obs.observe(s)});
</script>
</body>
</html>`;

writeFileSync(join(DIR, 'index.html'), html, 'utf-8');
console.log(`Generated index.html (${(html.length / 1024).toFixed(0)} KB) with ${chapters.length} chapters`);
