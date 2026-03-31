# 09 - UI Component System: A Full-Featured React Application in the Terminal

## Overview

Claude Code's UI layer is a remarkable feat of engineering: a **near-desktop-grade** full-featured React application built on a terminal character grid. The entire UI system consists of the following parts:

| Module | File Count | Lines of Code | Core Responsibility |
|--------|-----------|---------------|---------------------|
| `components/` | ~144 top-level + subdirectories | ~76k | Business UI components |
| `ink/` | ~50 core files | ~8,300 (9 core files) | Custom rendering engine |
| `screens/` | 3 files | ~5,005 (REPL) | Page-level components |
| `outputStyles/` | 1 file | ~80 | Output style loading |

Tech stack: React 19 Concurrent Mode + deeply customized Ink fork + Yoga layout engine + React Compiler Runtime automatic memoization.

---

## 1. REPL.tsx "God Component" Deep Dive

### 1.1 Scale Overview

REPL.tsx is the **heart** of the entire application -- 5,005 lines of code, 280+ imports, one massive function component.

```typescript
// screens/REPL.tsx opening import stack (representative excerpt)
import { c as _c } from "react/compiler-runtime";  // React Compiler runtime
import { useInput } from '../ink.js';                // Terminal keyboard input
import { Box, Text, useStdin, useTheme, useTerminalFocus, useTerminalTitle, useTabStatus } from '../ink.js';
import { useNotifications } from '../context/notifications.js';
import { query } from '../query.js';                 // Core API call
// ... 270+ more imports
```

### 1.2 Key State Management

The REPL component internally manages the vast majority of the application's state:

```typescript
export function REPL({ commands, debug, initialTools, ... }: Props) {
  // -- Global application state (via zustand-like store) --
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const plugins = useAppState(s => s.plugins);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const tasks = useAppState(s => s.tasks);
  const elicitation = useAppState(s => s.elicitation);
  // ... 20+ more selectors

  // -- Local UI state --
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  // ... 50+ more local states
}
```

REPL's state management employs a **dual-layer architecture**:
- **AppState Store** (zustand-like): Cross-component shared state, selectively subscribed via `useAppState(selector)`
- **Local useState**: UI-exclusive ephemeral state, such as dialog visibility, input values, scroll positions, etc.

### 1.3 What 280+ Imports Reveal About Dependencies

Import breakdown by category for REPL:

| Category | Count | Representative Modules |
|----------|-------|----------------------|
| UI Components | ~50 | `Messages`, `PromptInput`, `PermissionRequest`, `CostThresholdDialog` |
| Hooks | ~40 | `useApiKeyVerification`, `useReplBridge`, `useVirtualScroll` |
| Tools/Commands | ~20 | `getTools`, `assembleToolPool`, `query` |
| State Management | ~15 | `useAppState`, `useSetAppState`, `useCommandQueue` |
| Session/History | ~15 | `sessionStorage`, `sessionRestore`, `conversationRecovery` |
| Notification System | ~15 | `useRateLimitWarningNotification`, `useDeprecationWarningNotification` |
| Keyboard Shortcuts | ~10 | `GlobalKeybindingHandlers`, `useShortcutDisplay` |
| Conditional Loading | ~10 | `feature('VOICE_MODE')`, `feature('ULTRAPLAN')` |
| Other | ~100+ | Utility functions, type definitions, constants, etc. |

### 1.4 Why It Wasn't Split -- Intentional Design or Tech Debt?

**Verdict: Primarily intentional design, supplemented by pragmatic engineering compromises.**

Analysis:

1. **The uniqueness of terminal UI**: Terminals have no routing system; REPL is the only "page." All interactions (input, permission confirmations, dialogs, message lists) happen on the same terminal screen, naturally converging into a single orchestrator.

2. **Centralized focus management**: A terminal can only have one focus target at a time. The `focusedInputDialog` variable in REPL is a finite state machine managing 15+ mutually exclusive input focuses:
   ```
   'permission' | 'sandbox-permission' | 'elicitation' | 'prompt' |
   'cost' | 'idle-return' | 'message-selector' | 'ide-onboarding' |
   'model-switch' | 'effort-callout' | 'remote-callout' | 'lsp-recommendation' |
   'plugin-hint' | 'desktop-upsell' | 'ultraplan-choice' | 'ultraplan-launch' | ...
   ```
   Splitting would spread this state machine's management across multiple files, increasing coordination complexity.

3. **React Compiler as a mitigating factor**: The entire REPL function body is processed by the React Compiler, with every JSX fragment and computation wrapped in `_c()` cache arrays. Even though the component is massive, React only recomputes the parts that actually changed.

4. **Signs of extraction**: A substantial amount of logic has already been extracted into standalone hooks (40+), and child components are independently defined. REPL is more of an **orchestrator** than a monolith that does everything.

---

## 2. Custom Ink Rendering Engine

### 2.1 Architecture Overview

Claude Code uses a **deeply customized fork** of Ink, not the community version. The full rendering pipeline:

```
React Tree -> Reconciler -> DOM Tree -> Yoga Layout -> Screen Buffer -> Diff -> ANSI -> stdout
            (reconciler.ts) (dom.ts)  (yoga.ts)    (renderer.ts)  (log-update.ts)
                                                    (output.ts)    (terminal.ts)
                                                    (screen.ts)
```

Core file sizes:

| File | Lines | Responsibility |
|------|-------|----------------|
| `ink.tsx` | 1,722 | Ink instance: frame scheduling, mouse events, selection overlay |
| `screen.ts` | 1,486 | Screen buffer + three object pools |
| `render-node-to-output.ts` | 1,462 | DOM -> Screen Buffer rendering |
| `selection.ts` | 917 | Text selection system |
| `output.ts` | 797 | Operation collector (write/blit/clip/clear) |
| `log-update.ts` | 773 | Screen Buffer -> Diff -> ANSI patches |
| `reconciler.ts` | 512 | React Reconciler adapter |
| `dom.ts` | 484 | Custom DOM nodes |
| `renderer.ts` | 178 | Renderer: DOM -> Frame |

### 2.2 Double Buffering Implementation: frontFrame / backFrame

This is the most critical optimization of the entire rendering engine. In the `Ink` class within `ink.tsx`:

```typescript
class Ink {
  private frontFrame: Frame;  // Previous frame: content currently displayed in terminal
  private backFrame: Frame;   // Back buffer: the next frame being constructed

  constructor() {
    this.frontFrame = emptyFrame(rows, cols, stylePool, charPool, hyperlinkPool);
    this.backFrame = emptyFrame(rows, cols, stylePool, charPool, hyperlinkPool);
  }
}
```

`Frame` structure definition (`frame.ts`):
```typescript
export type Frame = {
  readonly screen: Screen;           // Character grid buffer
  readonly viewport: Size;           // Terminal viewport dimensions
  readonly cursor: Cursor;           // Cursor position
  readonly scrollHint?: ScrollHint;  // DECSTBM hardware scroll optimization hint
  readonly scrollDrainPending?: boolean;
};
```

**The diff algorithm** is implemented in `LogUpdate.render()` within `log-update.ts`:

```typescript
render(prev: Frame, next: Frame, altScreen = false, decstbmSafe = true): Diff {
  // 1. Detect viewport changes -> requires full redraw
  if (next.viewport.height < prev.viewport.height || ...) {
    return fullResetSequence_CAUSES_FLICKER(next, 'resize', stylePool);
  }

  // 2. DECSTBM hardware scroll optimization (alt-screen only)
  if (altScreen && next.scrollHint && decstbmSafe) {
    shiftRows(prev.screen, top, bottom, delta);  // Simulate shift so diff only discovers new rows
    scrollPatch = [{ type: 'stdout', content: setScrollRegion(...) + csiScrollUp(...) }];
  }

  // 3. Line-by-line, cell-by-cell diff
  diffEach(prevScreen, nextScreen, ...)  // Core diff in screen.ts
}
```

The core is `diffEach()` (defined in `screen.ts`), which performs **cell-by-cell comparison** between two Screen buffers, using packed integers (charId + styleId encoded as a single number) to achieve O(1) cell comparison.

### 2.3 Custom React Reconciler Implementation

`reconciler.ts` creates a custom reconciler based on the `react-reconciler` package, adapted for the terminal DOM:

```typescript
const reconciler = createReconciler<
  ElementNames,     // 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text' | 'ink-link' | 'ink-raw-ansi'
  Props,
  DOMElement,       // Custom DOM nodes
  ...
>({
  getRootHostContext: () => ({ isInsideText: false }),

  createInstance(type, props, _root, hostContext, internalHandle) {
    // Create DOM node + create Yoga layout node
    const node = createNode(type);
    // Apply props (style -> Yoga, event handlers -> _eventHandlers)
    for (const [key, value] of Object.entries(props)) {
      applyProp(node, key, value);
    }
    return node;
  },

  resetAfterCommit(rootNode) {
    // Key: trigger Yoga layout calculation + rendering in the commit phase
    rootNode.onComputeLayout();  // Yoga calculateLayout
    rootNode.onRender();         // Frame rendering
  },
});
```

Six DOM element types:
- `ink-root`: Root node
- `ink-box`: Flexbox container (maps to `<Box>`)
- `ink-text`: Text node (maps to `<Text>`)
- `ink-virtual-text`: Nested text (`<Text>` inside `<Text>`)
- `ink-link`: Hyperlink (OSC 8 protocol)
- `ink-raw-ansi`: Raw ANSI passthrough

### 2.4 Object Pools -- Three Memory Optimization Powerhouses

Three pooling classes defined in `screen.ts`:

**CharPool (character string pool)**:
```typescript
export class CharPool {
  private strings: string[] = [' ', ''];  // Index 0 = space, 1 = empty
  private ascii: Int32Array = initCharAscii();  // ASCII fast path

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;  // O(1) array lookup
        // ...
      }
    }
    // Unicode falls back to Map
    return this.stringMap.get(char) ?? this.allocNew(char);
  }
}
```
ASCII characters use Int32Array direct indexing (zero hashing, zero comparison); Unicode falls back to Map. blitRegion can directly copy charIds (integers) without string comparison.

**StylePool (style pool)**:
```typescript
export class StylePool {
  intern(styles: AnsiCode[]): number {
    // Bit 0 encodes visibility: odd IDs = has visual effect on spaces (background color, inverse, etc.)
    id = (rawId << 1) | (hasVisibleSpaceEffect(styles) ? 1 : 0);
    return id;
  }

  transition(fromId: number, toId: number): string {
    // Cache (fromId, toId) -> ANSI transition string, zero allocation on hot path
    const key = fromId * 0x100000 + toId;
    return this.transitionCache.get(key) ?? this.computeAndCache(key);
  }
}
```
The Bit 0 trick allows the renderer to skip unstyled spaces using bitwise operations -- this is the most critical optimization in the diff hot loop.

**HyperlinkPool**: Similar to CharPool, converts hyperlink URL strings to integer IDs, where Index 0 = no hyperlink.

### 2.5 Mouse Events and Text Selection

Claude Code implements a **complete mouse interaction system** in the terminal:

**Mouse protocol** (enabled via DEC private modes):
```typescript
// ink/termio/dec.ts
const ENABLE_MOUSE_TRACKING  = '\x1b[?1003;1006h';  // SGR encoding + any-event tracking
const DISABLE_MOUSE_TRACKING = '\x1b[?1003;1006l';
```

**Hit-test system** (`hit-test.ts`):
```typescript
export function hitTest(node: DOMElement, col: number, row: number): DOMElement | null {
  const rect = nodeCache.get(node);  // Screen coordinates cached from rendering phase
  // Bounds check -> reverse child traversal (later-drawn nodes are on top) -> recurse
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const hit = hitTest(child, col, row);
    if (hit) return hit;
  }
  return node;
}
```

**Text selection** (`selection.ts`, 917 lines) implements:
- Character-level, double-click word, triple-click line selection
- Drag selection (anchor + focus model)
- Selection offset during scrolling (`shiftSelection`, `scrolledOffAbove/Below` accumulators)
- Selection overlay rendered via StylePool.withInverse() for inverse colors
- Copy to clipboard (OSC 52 protocol)

**Event dispatching** (`dispatcher.ts`) mimics React DOM's capture/bubble model:
```typescript
function collectListeners(target, event): DispatchListener[] {
  // Result: [root-capture, ..., parent-capture, target, parent-bubble, ..., root-bubble]
}
```

---

## 3. Component Classification System

The 144 top-level components (including subdirectories) are categorized into **13 classes** by functional domain:

| # | Category | Representative Components | Count | Description |
|---|----------|--------------------------|-------|-------------|
| 1 | **Message Rendering** | `Message.tsx`, `Messages.tsx`, `MessageRow.tsx`, `messages/` (34 files: `AssistantTextMessage`, `UserTextMessage`, `CompactBoundaryMessage`, ...) | ~40 | Full lifecycle rendering of conversation messages |
| 2 | **Input System** | `PromptInput/` (21 files: `PromptInput.tsx`, `HistorySearchInput`, `ShimmeredInput`, `Notifications.tsx`, `PromptInputFooter`) | ~25 | Command-line input, history search, auto-completion |
| 3 | **Permission Dialogs** | `permissions/` (25+ files: `PermissionRequest`, `BashPermissionRequest/`, `FileEditPermissionRequest/`, `SandboxPermissionRequest`) | ~30 | Tool usage approval UI |
| 4 | **Design System** | `design-system/` (16 files: `ThemedText`, `Dialog`, `Pane`, `Tabs`, `FuzzyPicker`, `ProgressBar`, `Divider`, `StatusIcon`) | 16 | Foundational UI primitives |
| 5 | **Scrolling & Virtualization** | `VirtualMessageList.tsx`, `ScrollKeybindingHandler.tsx`, `FullscreenLayout.tsx` | 3 | Fullscreen mode core |
| 6 | **Code & Diff** | `Markdown.tsx`, `HighlightedCode.tsx`, `StructuredDiff.tsx`, `diff/` (3 files), `FileEditToolDiff.tsx` | ~8 | Code rendering and file diffs |
| 7 | **MCP / Skills** | `mcp/` (10 files), `skills/SkillsMenu.tsx`, `agents/` (14 files) | ~25 | MCP service management, Agent editor |
| 8 | **Feedback & Surveys** | `FeedbackSurvey/` (9 files), `SkillImprovementSurvey.tsx` | ~10 | User feedback collection |
| 9 | **Configuration Dialogs** | `Settings/` (4 files), `ThemePicker`, `OutputStylePicker`, `ModelPicker`, `LanguagePicker`, `sandbox/` (5 files) | ~15 | Settings panels |
| 10 | **Status Indicators** | `Spinner/` (12 files), `StatusLine.tsx`, `StatusNotices.tsx`, `Stats.tsx`, `MemoryUsageIndicator.tsx`, `IdeStatusIndicator.tsx` | ~18 | Loading, progress, system status |
| 11 | **Navigation & Search** | `GlobalSearchDialog.tsx`, `HistorySearchDialog.tsx`, `QuickOpenDialog.tsx`, `MessageSelector.tsx` | ~5 | Global search and quick navigation |
| 12 | **Onboarding** | `Onboarding.tsx`, `LogoV2/` (15 files), `wizard/` (5 files), `ClaudeInChromeOnboarding.tsx` | ~22 | Welcome page, guided flows |
| 13 | **Miscellaneous** | `ExitFlow.tsx`, `AutoUpdater.tsx`, `TaskListV2.tsx`, `tasks/` (12 files), `teams/`, `TeleportProgress.tsx`, ... | ~30 | Exit confirmation, auto-update, task management, etc. |

### Data Flow Patterns Between Components

```
REPL (Orchestrator)
  |-- AppState Store (global state) --> useAppState(selector) --> child components
  |-- messages[] (message array) --> Messages --> VirtualMessageList --> MessageRow[]
  |-- focusedInputDialog (focus state machine) --> mutually exclusive dialog components
  |-- toolPermissionContext --> PermissionRequest --> child permission components
  \-- query() (API call) --> handleMessageFromStream --> setMessages / setStreamingToolUses
```

Data flow follows **React's unidirectional data flow**, with two important additions:
1. **Imperative Refs**: `ScrollBoxHandle`, `JumpHandle`, etc. expose imperative APIs via `useImperativeHandle`
2. **Event Bubbling**: Mouse clicks bubble from child to parent nodes through the custom `Dispatcher`

---

## 4. Performance Optimization Techniques

### 4.1 React Compiler Automatic Memoization

Nearly every component is compiled by the React Compiler, producing the following code pattern:

```typescript
function TranscriptModeFooter(t0) {
  const $ = _c(9);  // Cache array with 9 slots
  const { showAllInTranscript, virtualScroll, searchBadge, ... } = t0;

  let t3;
  if ($[0] !== t2 || $[1] !== toggleShortcut) {
    // Dependencies changed, recompute
    t3 = <Text dimColor>...</Text>;
    $[0] = t2; $[1] = toggleShortcut; $[2] = t3;
  } else {
    // Dependencies unchanged, reuse cache
    t3 = $[2];
  }
  return t3;
}
```

`_c(n)` allocates an array of length n for dependency comparison. This completely replaces hand-written `useMemo`, `useCallback`, and `React.memo` -- the compiler automatically performs fine-grained dependency tracking for every JSX expression.

The special marker `'use no memo'` (seen in `OffscreenFreeze.tsx`) can explicitly opt out of compiler optimization.

### 4.2 OffscreenFreeze

```typescript
export function OffscreenFreeze({ children }: Props) {
  'use no memo';  // Must opt out of React Compiler, otherwise cache mechanism breaks freeze logic
  const [ref, { isVisible }] = useTerminalViewport();
  const cached = useRef(children);

  if (isVisible || inVirtualList) {
    cached.current = children;  // Update cache when visible
  }
  // When offscreen, return cached old children -> React skips the entire subtree
  return <Box ref={ref}>{cached.current}</Box>;
}
```

**Principle**: If content above the terminal scroll area changes, `log-update.ts` must perform a full reset (it cannot partially update rows that have scrolled out of view). Components that update periodically, such as spinners and timers, are frozen when offscreen, producing zero diff.

### 4.3 VirtualMessageList Virtual Scrolling

`VirtualMessageList.tsx` implements virtualized rendering for the message list:

- **Height caching**: `heightCache` records the rendered height of each message, invalidated by `columns` dimension (window width changes cause text reflow)
- **Visible window calculation**: The `useVirtualScroll` hook calculates the range of messages to mount based on ScrollBox's scrollTop + viewportHeight
- **Sticky Prompt**: Tracks user scroll position via `ScrollChromeContext`, displaying the corresponding user input at the top of the scroll area

Search functionality:
```typescript
export type JumpHandle = {
  setSearchQuery: (q: string) => void;     // Set search query
  nextMatch: () => void;                    // Jump to next match
  warmSearchIndex: () => Promise<number>;   // Warm up search index (extract all message text)
  scanElement?: (el: DOMElement) => MatchPosition[];  // Scan DOM element for match positions
};
```

### 4.4 Markdown Token Caching

```typescript
// Markdown.tsx -- module-level LRU cache
const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();

function cachedLexer(content: string): Token[] {
  // Fast path: no Markdown syntax -> skip marked.lexer (~3ms)
  if (!hasMarkdownSyntax(content)) {
    return [{ type: 'paragraph', raw: content, text: content, tokens: [...] }];
  }
  // LRU cache, indexed by content hash
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) { tokenCache.delete(key); tokenCache.set(key, hit); return hit; }  // Promote to MRU
  // ...
}
```

`hasMarkdownSyntax()` uses a regex pre-check (only inspecting the first 500 characters) to skip full parsing of plain text content -- particularly effective for short replies and user input.

### 4.5 Blit Optimization (render-node-to-output.ts)

The rendering engine performs **blit** (block copy) for unchanged subtrees: if a node's Yoga position/size hasn't changed and the `dirty` flag is false, the corresponding region is copied directly from prevScreen to the current Screen, skipping the entire subtree traversal.

```typescript
// render-node-to-output.ts (conceptual)
if (!node.dirty && prevScreen && sameBounds) {
  blitRegion(prevScreen, screen, rect);  // O(width * height) integer copy
  return;  // Skip all child nodes
}
```

### 4.6 DECSTBM Hardware Scrolling

In alt-screen mode, when ScrollBox's scrollTop changes, instead of rewriting the entire region, terminal hardware scroll instructions are utilized:

```typescript
// log-update.ts
if (altScreen && next.scrollHint && decstbmSafe) {
  shiftRows(prev.screen, top, bottom, delta);  // Simulate shift on prev
  scrollPatch = [setScrollRegion(top+1, bottom+1) + csiScrollUp(delta) + RESET_SCROLL_REGION];
  // diff loop only discovers newly scrolled-in rows -> minimal patches
}
```

### 4.7 Diff Patch Optimizer

`optimizer.ts` performs a **single-pass optimization** on frame patches before they are written to the terminal:
- Remove empty stdout patches
- Merge consecutive cursorMove operations
- Concatenate adjacent styleStr (style transition diffs)
- Deduplicate consecutive hyperlinks
- Cancel out cursorHide/cursorShow pairs

---

## 5. Design System

### 5.1 Theme System

`design-system/ThemeProvider.tsx` implements complete theme switching:

```typescript
type ThemeSetting = 'dark' | 'light' | 'auto';

function ThemeProvider({ children }) {
  const [themeSetting, setThemeSetting] = useState(getGlobalConfig().theme);
  const [systemTheme, setSystemTheme] = useState<SystemTheme>('dark');

  // 'auto' mode: query terminal background color via OSC 11, dynamically track
  useEffect(() => {
    if (activeSetting !== 'auto') return;
    void import('../../utils/systemThemeWatcher.js').then(({ watchSystemTheme }) => {
      cleanup = watchSystemTheme(internal_querier, setSystemTheme);
    });
  }, [activeSetting]);
}
```

### 5.2 ThemedText -- Theme-Aware Text Component

```typescript
export default function ThemedText({ color, dimColor, bold, ... }) {
  const theme = useTheme();
  const hoverColor = useContext(TextHoverColorContext);

  // Color resolution: theme key -> raw color
  function resolveColor(color: keyof Theme | Color): Color {
    if (color.startsWith('rgb(') || color.startsWith('#')) return color;
    return theme[color as keyof Theme];
  }
}
```

Supported color formats: `rgb(r,g,b)`, `#hex`, `ansi256(n)`, `ansi:name`, and theme keys.

### 5.3 Foundational UI Primitives

The `design-system/` directory provides 16 foundational components:

| Component | Purpose |
|-----------|---------|
| `Dialog` | Modal dialog (with Esc to cancel, Enter to confirm shortcuts) |
| `Pane` | Bordered panel container |
| `Tabs` | Tab switching |
| `FuzzyPicker` | Fuzzy search selector (files, commands) |
| `ProgressBar` | Progress bar |
| `Divider` | Separator line |
| `StatusIcon` | Status icon (success/failure/loading) |
| `ListItem` | List item (with indentation and markers) |
| `LoadingState` | Loading skeleton |
| `Ratchet` | Monotonically increasing animation value (anti-jitter) |
| `KeyboardShortcutHint` | Keyboard shortcut hint |
| `Byline` | Bottom description line |
| `ThemedText` | Theme-aware text |
| `ThemedBox` | Theme-aware container |
| `ThemeProvider` | Theme context |

---

## 6. Differences from Web React -- Unique Challenges of Terminal React Development

### 6.1 No DOM, Only a Character Grid

Web React's `div` maps to pixel rectangles; terminal React's `Box` maps to character rectangles. A CJK character occupies 2 columns, an emoji may occupy 2-3 columns, and grapheme cluster width calculation relies on `@alcalzone/ansi-tokenize` + ICU segmenter.

### 6.2 No CSS, Only Yoga

Flexbox layout is implemented via Yoga WASM. There is no `position: fixed`, `float`, or `grid`. `overflow: scroll` must be implemented manually (ScrollBox). `position: absolute` requires special handling (blit optimization must be aware of absolute node removal to avoid ghost artifacts).

### 6.3 No Event System, Built from Scratch

Terminals only provide raw keypress escape sequences and SGR mouse events. Claude Code built a complete event system from the ground up:
- **Keyboard**: `parse-keypress.ts` parses escape sequences into `KeyboardEvent`
- **Mouse**: SGR 1003 mode -> hit-test -> ClickEvent/HoverEvent
- **Capture/Bubble**: `dispatcher.ts` mimics DOM event propagation
- **Focus Management**: `focus.ts` + `FocusManager`

### 6.4 Diffing Costs Far More Than on the Web

Web browsers have incremental layout and GPU compositing. The terminal's "fallback strategy" is a full screen clear and redraw -- at the cost of **visible flicker**. This is why:
- `OffscreenFreeze` freezes offscreen components
- `blit` skips unchanged subtrees
- `DECSTBM` leverages hardware scrolling
- `optimizer.ts` compresses patch count
- `shouldClearScreen()` avoids full resets whenever possible

### 6.5 No Hot Reload, Difficult Testing

Terminal UI cannot use Storybook/Playwright. React DevTools requires special configuration (`reconciler.ts` has a code path for `injectIntoDevTools`). Debugging tools rely on environment variables (`CLAUDE_CODE_DEBUG_REPAINTS`, `CLAUDE_CODE_COMMIT_LOG`) that write to file logs.

### 6.6 Actual Usage of Concurrent Mode

React 19 Concurrent Mode takes effect in the terminal through the following mechanisms:
- `ConcurrentRoot` creates the root container
- `useDeferredValue` is used for deferring computationally expensive values
- `Suspense` is used for async loading of syntax highlighting (`<Suspense fallback=...>` in `Markdown.tsx`)
- Frame scheduling is controlled via `throttle(queueMicrotask(onRender), FRAME_INTERVAL_MS)`

---

## Summary

Claude Code's UI system is essentially **a mini browser rebuilt inside the terminal**: custom DOM, Yoga layout, double-buffered rendering, event bubbling, text selection, hardware scroll optimization -- all of this infrastructure that is taken for granted on the Web must be built from scratch in the terminal.

REPL.tsx's 5,000 lines of code is not the "God Component" anti-pattern, but rather the **orchestration hub** of the terminal UI -- in a terminal with no routing, it is the sole "router." React Compiler's automatic memoization ensures this massive component does not become a performance bottleneck.

The design philosophy of the entire rendering engine is to **avoid full-screen redraws**: reusing unchanged regions via blit, freezing offscreen components via OffscreenFreeze, leveraging hardware scrolling via DECSTBM, and eliminating GC pressure via object pools -- each optimization directly addresses a specific pain point of terminal rendering.
