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
function md2html(md) {
  let html = md;
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
    // Headers
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      const level = hMatch[1].length;
      const text = inlineMarkdown(hMatch[2]);
      out.push(`<h${level + 1}>${text}</h${level + 1}>`);
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
  return out.join('\n');
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

// ── Load MD files ──
const mdFiles = readdirSync(DIR)
  .filter(f => f.endsWith('.md') && /^\d{2}-/.test(f))
  .sort();

const chapters = mdFiles.map(f => {
  const raw = readFileSync(join(DIR, f), 'utf-8');
  const num = f.slice(0, 2);
  const titleMatch = raw.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].replace(/^\d+\s*-\s*/, '') : f;
  const body = raw.replace(/^#\s+.+\n+/, ''); // remove first H1
  return { num, title, id: `ch${num}`, file: f, html: md2html(body) };
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
};

// ── HTML Template ──
const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light" data-lang="cn">
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

.footer{padding:30px 45px;text-align:center;color:var(--fg3);font-size:12px}
@media(max-width:800px){.sidebar{display:none}.main{margin-left:0}.hero,.chapter{padding:20px 16px}}
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
    <button class="tbtn" onclick="changeFont(-2)">A-</button>
    <span id="fsLabel" style="color:var(--fg2);font-size:13px;min-width:38px;text-align:center">16px</span>
    <button class="tbtn" onclick="changeFont(2)">A+</button>
    <button class="tbtn" onclick="toggleTheme()" id="themeBtn">Dark</button>
  </div>
</div>

<nav class="sidebar">
  <a href="#overview"><span class="n">--</span>Overview</a>
${chapters.map(c => `  <a href="#${c.id}"><span class="n">${c.num}</span>${c.title.slice(0, 28)}</a>`).join('\n')}
</nav>

<div class="main">
  <div class="hero" id="overview">
    <h1>Decode <span>Claude Code</span></h1>
    <p class="sub">1,906 source files extracted from 59.8MB source map — module-by-module deep architecture analysis covering 515,029 lines of code.</p>
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
    <h2>${c.num} — ${c.title}</h2>
    ${diagHtml}
    ${c.html}
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

// Sidebar active tracking
const secs=document.querySelectorAll('.chapter,.hero'),links=document.querySelectorAll('.sidebar a');
const obs=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){links.forEach(l=>l.classList.remove('active'));const l=document.querySelector('.sidebar a[href="#'+e.target.id+'"]');if(l)l.classList.add('active')}})},{rootMargin:'-10% 0px -70% 0px'});
secs.forEach(s=>{if(s.id)obs.observe(s)});
</script>
</body>
</html>`;

writeFileSync(join(DIR, 'index.html'), html, 'utf-8');
console.log(`Generated index.html (${(html.length / 1024).toFixed(0)} KB) with ${chapters.length} chapters`);
