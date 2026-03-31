# 09 - UI 组件系统：终端中的全功能 React 应用

## 概述

Claude Code 的 UI 层是一个令人惊叹的工程作品：在终端字符网格上构建了一套**接近桌面应用级别**的全功能 React 应用。整个 UI 系统由以下部分构成：

| 模块 | 文件数 | 代码行 | 核心职责 |
|------|--------|--------|----------|
| `components/` | ~144 顶层 + 子目录 | ~76k | 业务 UI 组件 |
| `ink/` | ~50 核心文件 | ~8,300 (核心9文件) | 自定义渲染引擎 |
| `screens/` | 3 文件 | ~5,005 (REPL) | 页面级组件 |
| `outputStyles/` | 1 文件 | ~80 | 输出风格加载 |

技术栈：React 19 Concurrent Mode + 深度定制的 Ink fork + Yoga 布局引擎 + React Compiler Runtime 自动 memoization。

---

## 一、REPL.tsx "上帝组件"深度分析

### 1.1 规模概览

REPL.tsx 是整个应用的**心脏**——5,005 行代码、280+ imports、一个巨大的函数组件。

```typescript
// screens/REPL.tsx 开头的 import 堆叠（截取代表性片段）
import { c as _c } from "react/compiler-runtime";  // React Compiler 运行时
import { useInput } from '../ink.js';                // 终端键盘输入
import { Box, Text, useStdin, useTheme, useTerminalFocus, useTerminalTitle, useTabStatus } from '../ink.js';
import { useNotifications } from '../context/notifications.js';
import { query } from '../query.js';                 // API 调用核心
// ... 270+ more imports
```

### 1.2 关键状态管理

REPL 组件内部管理着整个应用的绝大部分状态：

```typescript
export function REPL({ commands, debug, initialTools, ... }: Props) {
  // -- 全局应用状态（通过 zustand-like store） --
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const plugins = useAppState(s => s.plugins);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const tasks = useAppState(s => s.tasks);
  const elicitation = useAppState(s => s.elicitation);
  // ... 20+ more selectors

  // -- 本地 UI 状态 --
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  // ... 50+ more local states
}
```

REPL 的状态管理采用**双层架构**：
- **AppState Store**（类 zustand）：跨组件共享状态，通过 `useAppState(selector)` 选择性订阅
- **本地 useState**：UI 专属瞬态状态，如对话框可见性、输入值、滚动位置等

### 1.3 280+ Imports 反映的依赖关系

按类别统计 REPL 的 imports：

| 类别 | 数量 | 代表性模块 |
|------|------|-----------|
| UI 组件 | ~50 | `Messages`, `PromptInput`, `PermissionRequest`, `CostThresholdDialog` |
| Hooks | ~40 | `useApiKeyVerification`, `useReplBridge`, `useVirtualScroll` |
| 工具/命令 | ~20 | `getTools`, `assembleToolPool`, `query` |
| 状态管理 | ~15 | `useAppState`, `useSetAppState`, `useCommandQueue` |
| 会话/历史 | ~15 | `sessionStorage`, `sessionRestore`, `conversationRecovery` |
| 通知系统 | ~15 | `useRateLimitWarningNotification`, `useDeprecationWarningNotification` |
| 快捷键 | ~10 | `GlobalKeybindingHandlers`, `useShortcutDisplay` |
| 条件加载 | ~10 | `feature('VOICE_MODE')`, `feature('ULTRAPLAN')` |
| 其他 | ~100+ | 工具函数、类型定义、常量等 |

### 1.4 为什么没有拆分——有意设计还是技术债？

**判断：主要是有意设计，辅以务实的工程妥协。**

原因分析：

1. **终端 UI 的特殊性**：终端没有路由系统，REPL 就是唯一的"页面"。所有交互（输入、权限确认、对话框、消息列表）都发生在同一个终端屏幕上，自然聚合到一个协调器。

2. **焦点管理的集中性**：终端同一时间只有一个焦点目标。REPL 中的 `focusedInputDialog` 变量是一个有限状态机，管理着 15+ 种互斥的输入焦点：
   ```
   'permission' | 'sandbox-permission' | 'elicitation' | 'prompt' |
   'cost' | 'idle-return' | 'message-selector' | 'ide-onboarding' |
   'model-switch' | 'effort-callout' | 'remote-callout' | 'lsp-recommendation' |
   'plugin-hint' | 'desktop-upsell' | 'ultraplan-choice' | 'ultraplan-launch' | ...
   ```
   拆分会让这个状态机的管理跨越多个文件，增加协调复杂度。

3. **React Compiler 的缓解作用**：整个 REPL 函数体被 React Compiler 处理，每一段 JSX 和计算都被 `_c()` 缓存数组包裹。即使组件巨大，React 也只重新计算发生变化的部分。

4. **提取的迹象**：已经有大量逻辑被提取为独立 hooks（40+ 个），子组件也各自独立。REPL 更像是一个**编排器**而非一个做所有事情的巨石。

---

## 二、自定义 Ink 渲染引擎

### 2.1 架构总览

Claude Code 使用的是 Ink 的**深度定制 fork**，而非社区版本。整个渲染管线：

```
React Tree → Reconciler → DOM Tree → Yoga Layout → Screen Buffer → Diff → ANSI → stdout
            (reconciler.ts) (dom.ts)  (yoga.ts)    (renderer.ts)  (log-update.ts)
                                                    (output.ts)    (terminal.ts)
                                                    (screen.ts)
```

核心文件规模：

| 文件 | 行数 | 职责 |
|------|------|------|
| `ink.tsx` | 1,722 | Ink 实例：帧调度、鼠标事件、选择覆盖 |
| `screen.ts` | 1,486 | 屏幕缓冲区 + 三大对象池 |
| `render-node-to-output.ts` | 1,462 | DOM → Screen Buffer 渲染 |
| `selection.ts` | 917 | 文本选择系统 |
| `output.ts` | 797 | 操作收集器（write/blit/clip/clear） |
| `log-update.ts` | 773 | Screen Buffer → Diff → ANSI patches |
| `reconciler.ts` | 512 | React Reconciler 适配 |
| `dom.ts` | 484 | 自定义 DOM 节点 |
| `renderer.ts` | 178 | 渲染器：DOM → Frame |

### 2.2 双缓冲的实现：frontFrame / backFrame

这是整个渲染引擎最核心的优化。在 `ink.tsx` 的 `Ink` 类中：

```typescript
class Ink {
  private frontFrame: Frame;  // 上一帧：当前显示在终端上的内容
  private backFrame: Frame;   // 后缓冲：正在构建的下一帧

  constructor() {
    this.frontFrame = emptyFrame(rows, cols, stylePool, charPool, hyperlinkPool);
    this.backFrame = emptyFrame(rows, cols, stylePool, charPool, hyperlinkPool);
  }
}
```

`Frame` 结构定义（`frame.ts`）：
```typescript
export type Frame = {
  readonly screen: Screen;           // 字符网格缓冲区
  readonly viewport: Size;           // 终端视口尺寸
  readonly cursor: Cursor;           // 光标位置
  readonly scrollHint?: ScrollHint;  // DECSTBM 硬件滚动优化提示
  readonly scrollDrainPending?: boolean;
};
```

**差分算法**在 `log-update.ts` 的 `LogUpdate.render()` 中实现：

```typescript
render(prev: Frame, next: Frame, altScreen = false, decstbmSafe = true): Diff {
  // 1. 检测视口变化 → 需要全量重绘
  if (next.viewport.height < prev.viewport.height || ...) {
    return fullResetSequence_CAUSES_FLICKER(next, 'resize', stylePool);
  }

  // 2. DECSTBM 硬件滚动优化（alt-screen only）
  if (altScreen && next.scrollHint && decstbmSafe) {
    shiftRows(prev.screen, top, bottom, delta);  // 模拟移位让 diff 只发现新行
    scrollPatch = [{ type: 'stdout', content: setScrollRegion(...) + csiScrollUp(...) }];
  }

  // 3. 逐行逐单元格差分
  diffEach(prevScreen, nextScreen, ...)  // screen.ts 中的核心 diff
}
```

核心是 `diffEach()`（定义在 `screen.ts`），它在两个 Screen 缓冲区之间做**逐单元格比较**，利用 packed integer（charId + styleId 编码为一个数字）实现 O(1) 的单元格比较。

### 2.3 React Reconciler 的自定义实现

`reconciler.ts` 基于 `react-reconciler` 包创建自定义 reconciler，适配终端 DOM：

```typescript
const reconciler = createReconciler<
  ElementNames,     // 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text' | 'ink-link' | 'ink-raw-ansi'
  Props,
  DOMElement,       // 自定义 DOM 节点
  ...
>({
  getRootHostContext: () => ({ isInsideText: false }),

  createInstance(type, props, _root, hostContext, internalHandle) {
    // 创建 DOM 节点 + 创建 Yoga 布局节点
    const node = createNode(type);
    // 应用 props（style → Yoga, 事件处理器 → _eventHandlers）
    for (const [key, value] of Object.entries(props)) {
      applyProp(node, key, value);
    }
    return node;
  },

  resetAfterCommit(rootNode) {
    // 关键：在 commit 阶段触发 Yoga 布局计算 + 渲染
    rootNode.onComputeLayout();  // Yoga calculateLayout
    rootNode.onRender();         // 帧渲染
  },
});
```

六种 DOM 元素类型：
- `ink-root`：根节点
- `ink-box`：Flexbox 容器（对应 `<Box>`）
- `ink-text`：文本节点（对应 `<Text>`）
- `ink-virtual-text`：嵌套文本（`<Text>` 内的 `<Text>`）
- `ink-link`：超链接（OSC 8 协议）
- `ink-raw-ansi`：原始 ANSI 透传

### 2.4 对象池——三大内存优化利器

定义在 `screen.ts` 中的三个池化类：

**CharPool（字符字符串池）**：
```typescript
export class CharPool {
  private strings: string[] = [' ', ''];  // Index 0 = space, 1 = empty
  private ascii: Int32Array = initCharAscii();  // ASCII 快速路径

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;  // O(1) 数组查找
        // ...
      }
    }
    // Unicode 回退到 Map
    return this.stringMap.get(char) ?? this.allocNew(char);
  }
}
```
ASCII 字符走 Int32Array 直接索引（零哈希、零比较），Unicode 走 Map。blitRegion 可以直接复制 charId（整数），无需字符串比较。

**StylePool（样式池）**：
```typescript
export class StylePool {
  intern(styles: AnsiCode[]): number {
    // Bit 0 编码可见性：奇数 ID = 对空格有视觉效果（背景色、反转等）
    id = (rawId << 1) | (hasVisibleSpaceEffect(styles) ? 1 : 0);
    return id;
  }

  transition(fromId: number, toId: number): string {
    // 缓存 (fromId, toId) → ANSI 转换字符串，热路径零分配
    const key = fromId * 0x100000 + toId;
    return this.transitionCache.get(key) ?? this.computeAndCache(key);
  }
}
```
Bit 0 的巧思让渲染器可以用位运算跳过无样式的空格——这是 diff 热循环中最关键的优化。

**HyperlinkPool**：与 CharPool 类似，将超链接 URL 字符串转为整数 ID，Index 0 = 无超链接。

### 2.5 鼠标事件和文本选择

Claude Code 在终端中实现了**完整的鼠标交互系统**：

**鼠标协议**（通过 DEC 私有模式启用）：
```typescript
// ink/termio/dec.ts
const ENABLE_MOUSE_TRACKING  = '\x1b[?1003;1006h';  // SGR 编码 + 任意事件跟踪
const DISABLE_MOUSE_TRACKING = '\x1b[?1003;1006l';
```

**hit-test 系统**（`hit-test.ts`）：
```typescript
export function hitTest(node: DOMElement, col: number, row: number): DOMElement | null {
  const rect = nodeCache.get(node);  // 从渲染阶段缓存的屏幕坐标
  // 边界检查 → 子节点反向遍历（后绘制的在上层）→ 递归
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const hit = hitTest(child, col, row);
    if (hit) return hit;
  }
  return node;
}
```

**文本选择**（`selection.ts`，917 行）实现了：
- 字符级、双击单词、三击整行选择
- 拖拽选择（anchor + focus 模型）
- 滚动时选择偏移（`shiftSelection`、`scrolledOffAbove/Below` 累积器）
- 选择覆盖层通过 StylePool.withInverse() 反色渲染
- 复制到剪贴板（OSC 52 协议）

**事件分派**（`dispatcher.ts`）仿照 React DOM 的捕获/冒泡模型：
```typescript
function collectListeners(target, event): DispatchListener[] {
  // 结果：[root-capture, ..., parent-capture, target, parent-bubble, ..., root-bubble]
}
```

---

## 三、组件分类体系

按功能域将 144 个顶层组件（含子目录）分为 **13 个类别**：

| # | 类别 | 代表性组件 | 数量 | 说明 |
|---|------|-----------|------|------|
| 1 | **消息渲染** | `Message.tsx`, `Messages.tsx`, `MessageRow.tsx`, `messages/` (34 文件: `AssistantTextMessage`, `UserTextMessage`, `CompactBoundaryMessage`, ...) | ~40 | 对话消息的全生命周期渲染 |
| 2 | **输入系统** | `PromptInput/` (21 文件: `PromptInput.tsx`, `HistorySearchInput`, `ShimmeredInput`, `Notifications.tsx`, `PromptInputFooter`) | ~25 | 命令行输入、历史搜索、自动补全 |
| 3 | **权限对话框** | `permissions/` (25+ 文件: `PermissionRequest`, `BashPermissionRequest/`, `FileEditPermissionRequest/`, `SandboxPermissionRequest`) | ~30 | 工具使用审批 UI |
| 4 | **设计系统** | `design-system/` (16 文件: `ThemedText`, `Dialog`, `Pane`, `Tabs`, `FuzzyPicker`, `ProgressBar`, `Divider`, `StatusIcon`) | 16 | 基础 UI 原语 |
| 5 | **滚动与虚拟化** | `VirtualMessageList.tsx`, `ScrollKeybindingHandler.tsx`, `FullscreenLayout.tsx` | 3 | 全屏模式核心 |
| 6 | **代码与 Diff** | `Markdown.tsx`, `HighlightedCode.tsx`, `StructuredDiff.tsx`, `diff/` (3 文件), `FileEditToolDiff.tsx` | ~8 | 代码渲染与文件差异 |
| 7 | **MCP / 技能** | `mcp/` (10 文件), `skills/SkillsMenu.tsx`, `agents/` (14 文件) | ~25 | MCP 服务管理、Agent 编辑器 |
| 8 | **反馈与调研** | `FeedbackSurvey/` (9 文件), `SkillImprovementSurvey.tsx` | ~10 | 用户反馈收集 |
| 9 | **配置对话框** | `Settings/` (4 文件), `ThemePicker`, `OutputStylePicker`, `ModelPicker`, `LanguagePicker`, `sandbox/` (5 文件) | ~15 | 设置面板 |
| 10 | **状态指示** | `Spinner/` (12 文件), `StatusLine.tsx`, `StatusNotices.tsx`, `Stats.tsx`, `MemoryUsageIndicator.tsx`, `IdeStatusIndicator.tsx` | ~18 | 加载、进度、系统状态 |
| 11 | **导航与搜索** | `GlobalSearchDialog.tsx`, `HistorySearchDialog.tsx`, `QuickOpenDialog.tsx`, `MessageSelector.tsx` | ~5 | 全局搜索与快速导航 |
| 12 | **Onboarding** | `Onboarding.tsx`, `LogoV2/` (15 文件), `wizard/` (5 文件), `ClaudeInChromeOnboarding.tsx` | ~22 | 欢迎页、引导流程 |
| 13 | **杂项** | `ExitFlow.tsx`, `AutoUpdater.tsx`, `TaskListV2.tsx`, `tasks/` (12 文件), `teams/`, `TeleportProgress.tsx`, ... | ~30 | 退出确认、自动更新、任务管理等 |

### 组件间的数据流模式

```
REPL (编排器)
  ├── AppState Store (全局状态) ──→ useAppState(selector) ──→ 子组件
  ├── messages[] (消息数组) ──→ Messages ──→ VirtualMessageList ──→ MessageRow[]
  ├── focusedInputDialog (焦点状态机) ──→ 互斥的对话框组件
  ├── toolPermissionContext ──→ PermissionRequest ──→ 子权限组件
  └── query() (API 调用) ──→ handleMessageFromStream ──→ setMessages / setStreamingToolUses
```

数据流遵循 **React 单向数据流**，但有两个重要补充：
1. **命令式 Ref**：`ScrollBoxHandle`、`JumpHandle` 等通过 `useImperativeHandle` 暴露命令式 API
2. **事件冒泡**：鼠标点击通过自定义 `Dispatcher` 从子节点冒泡到父节点

---

## 四、性能优化手段

### 4.1 React Compiler 自动 Memoization

几乎每个组件都经过 React Compiler 编译，生成的代码模式：

```typescript
function TranscriptModeFooter(t0) {
  const $ = _c(9);  // 9 槽位的缓存数组
  const { showAllInTranscript, virtualScroll, searchBadge, ... } = t0;

  let t3;
  if ($[0] !== t2 || $[1] !== toggleShortcut) {
    // 依赖变了，重新计算
    t3 = <Text dimColor>...</Text>;
    $[0] = t2; $[1] = toggleShortcut; $[2] = t3;
  } else {
    // 依赖没变，复用缓存
    t3 = $[2];
  }
  return t3;
}
```

`_c(n)` 分配一个长度为 n 的数组用于比较依赖项。这完全取代了手写的 `useMemo`、`useCallback`、`React.memo`——编译器对每个 JSX 表达式自动做细粒度的依赖追踪。

特殊标记 `'use no memo'`（见 `OffscreenFreeze.tsx`）可以显式退出编译器优化。

### 4.2 OffscreenFreeze

```typescript
export function OffscreenFreeze({ children }: Props) {
  'use no memo';  // 必须退出 React Compiler，否则 cache 机制会破坏冻结逻辑
  const [ref, { isVisible }] = useTerminalViewport();
  const cached = useRef(children);

  if (isVisible || inVirtualList) {
    cached.current = children;  // 可见时更新缓存
  }
  // 不可见时返回缓存的旧 children → React 跳过整个子树
  return <Box ref={ref}>{cached.current}</Box>;
}
```

**原理**：终端滚动区以上的内容如果发生变化，`log-update.ts` 必须做全量重置（无法局部更新已滚出的行）。Spinner、计时器等定期更新的组件在离屏时被冻结，产生零 diff。

### 4.3 VirtualMessageList 虚拟滚动

`VirtualMessageList.tsx` 实现了消息列表的虚拟化渲染：

- **高度缓存**：`heightCache` 记录每条消息的渲染高度，按 `columns` 维度失效（窗口宽度变化导致文本重排）
- **可见窗口计算**：`useVirtualScroll` hook 根据 ScrollBox 的 scrollTop + viewportHeight 计算需要挂载的消息范围
- **Sticky Prompt**：通过 `ScrollChromeContext` 跟踪用户滚动位置，在滚动区顶部显示当前对应的用户输入

搜索功能：
```typescript
export type JumpHandle = {
  setSearchQuery: (q: string) => void;     // 设置搜索词
  nextMatch: () => void;                    // 跳到下一个匹配
  warmSearchIndex: () => Promise<number>;   // 预热搜索索引（提取所有消息文本）
  scanElement?: (el: DOMElement) => MatchPosition[];  // 从 DOM 元素扫描匹配位置
};
```

### 4.4 Markdown Token 缓存

```typescript
// Markdown.tsx — 模块级 LRU 缓存
const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, Token[]>();

function cachedLexer(content: string): Token[] {
  // 快速路径：无 Markdown 语法 → 跳过 marked.lexer（~3ms）
  if (!hasMarkdownSyntax(content)) {
    return [{ type: 'paragraph', raw: content, text: content, tokens: [...] }];
  }
  // LRU 缓存，按内容哈希索引
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) { tokenCache.delete(key); tokenCache.set(key, hit); return hit; }  // 提升 MRU
  // ...
}
```

`hasMarkdownSyntax()` 通过正则预检（只检查前 500 字符）跳过纯文本内容的完整解析——对短回复和用户输入特别有效。

### 4.5 blit 优化（render-node-to-output.ts）

渲染引擎对没有变化的子树执行 **blit**（块复制）：如果一个节点的 Yoga 位置/尺寸没变且 `dirty` 标志为 false，直接从 prevScreen 复制对应区域到当前 Screen，跳过整个子树的遍历。

```typescript
// render-node-to-output.ts（概念）
if (!node.dirty && prevScreen && sameBounds) {
  blitRegion(prevScreen, screen, rect);  // O(width * height) 整数复制
  return;  // 跳过所有子节点
}
```

### 4.6 DECSTBM 硬件滚动

在 alt-screen 模式下，当 ScrollBox 的 scrollTop 变化时，不重写整个区域，而是利用终端的硬件滚动指令：

```typescript
// log-update.ts
if (altScreen && next.scrollHint && decstbmSafe) {
  shiftRows(prev.screen, top, bottom, delta);  // 在 prev 上模拟移位
  scrollPatch = [setScrollRegion(top+1, bottom+1) + csiScrollUp(delta) + RESET_SCROLL_REGION];
  // diff 循环只发现滚入的新行 → 极少的 patches
}
```

### 4.7 Diff Patch 优化器

`optimizer.ts` 在帧 patches 写入终端前做**单遍优化**：
- 删除空 stdout patch
- 合并连续 cursorMove
- 拼接相邻 styleStr（样式转换差分）
- 去重连续 hyperlink
- 抵消 cursorHide/cursorShow 对

---

## 五、设计系统

### 5.1 主题系统

`design-system/ThemeProvider.tsx` 实现完整的主题切换：

```typescript
type ThemeSetting = 'dark' | 'light' | 'auto';

function ThemeProvider({ children }) {
  const [themeSetting, setThemeSetting] = useState(getGlobalConfig().theme);
  const [systemTheme, setSystemTheme] = useState<SystemTheme>('dark');

  // 'auto' 模式：通过 OSC 11 查询终端背景色，动态跟踪
  useEffect(() => {
    if (activeSetting !== 'auto') return;
    void import('../../utils/systemThemeWatcher.js').then(({ watchSystemTheme }) => {
      cleanup = watchSystemTheme(internal_querier, setSystemTheme);
    });
  }, [activeSetting]);
}
```

### 5.2 ThemedText——主题感知的文本组件

```typescript
export default function ThemedText({ color, dimColor, bold, ... }) {
  const theme = useTheme();
  const hoverColor = useContext(TextHoverColorContext);

  // 颜色解析：theme key → raw color
  function resolveColor(color: keyof Theme | Color): Color {
    if (color.startsWith('rgb(') || color.startsWith('#')) return color;
    return theme[color as keyof Theme];
  }
}
```

支持的颜色格式：`rgb(r,g,b)`、`#hex`、`ansi256(n)`、`ansi:name`、以及主题 key。

### 5.3 基础 UI 原语

`design-system/` 目录提供了 16 个基础组件：

| 组件 | 用途 |
|------|------|
| `Dialog` | 模态对话框（带 Esc 取消、Enter 确认快捷键） |
| `Pane` | 带边框的面板容器 |
| `Tabs` | 标签页切换 |
| `FuzzyPicker` | 模糊搜索选择器（文件、命令） |
| `ProgressBar` | 进度条 |
| `Divider` | 分隔线 |
| `StatusIcon` | 状态图标（成功/失败/加载） |
| `ListItem` | 列表项（带缩进和标记） |
| `LoadingState` | 加载骨架屏 |
| `Ratchet` | 只增不减的动画值（防抖动） |
| `KeyboardShortcutHint` | 快捷键提示 |
| `Byline` | 底部说明行 |
| `ThemedText` | 主题感知文本 |
| `ThemedBox` | 主题感知容器 |
| `ThemeProvider` | 主题上下文 |

---

## 六、与 Web React 的差异——终端 React 开发的独特挑战

### 6.1 没有 DOM，只有字符网格

Web React 的 `div` → 像素矩形；终端 React 的 `Box` → 字符矩形。一个 CJK 字符占 2 列，emoji 可能占 2-3 列，grapheme cluster 的宽度计算依赖 `@alcalzone/ansi-tokenize` + ICU segmenter。

### 6.2 没有 CSS，只有 Yoga

Flexbox 布局通过 Yoga WASM 实现。没有 `position: fixed`、`float`、`grid`。`overflow: scroll` 需要自己实现（ScrollBox）。`position: absolute` 需要特殊处理（blit 优化需要感知 absolute 节点的移除以避免残影）。

### 6.3 没有事件系统，需要从零构建

终端只提供原始按键 escape sequence 和 SGR 鼠标事件。Claude Code 自建了完整的事件系统：
- **键盘**：`parse-keypress.ts` 解析 escape sequence → `KeyboardEvent`
- **鼠标**：SGR 1003 模式 → hit-test → ClickEvent/HoverEvent
- **捕获/冒泡**：`dispatcher.ts` 模仿 DOM 事件传播
- **焦点管理**：`focus.ts` + `FocusManager`

### 6.4 diff 的代价远高于 Web

Web 浏览器有增量布局和 GPU 合成。终端的"回退策略"是完全清屏重画——代价是**可见闪烁**。这就是为什么：
- `OffscreenFreeze` 冻结离屏组件
- `blit` 跳过未变子树
- `DECSTBM` 利用硬件滚动
- `optimizer.ts` 压缩 patch 数量
- `shouldClearScreen()` 尽量避免全量重置

### 6.5 没有热重载，测试困难

终端 UI 无法用 Storybook/Playwright。React DevTools 需要特殊配置（`reconciler.ts` 有 `injectIntoDevTools` 的代码路径）。调试工具依赖环境变量（`CLAUDE_CODE_DEBUG_REPAINTS`、`CLAUDE_CODE_COMMIT_LOG`）写文件日志。

### 6.6 Concurrent Mode 的实际使用

React 19 Concurrent Mode 在终端中通过以下方式生效：
- `ConcurrentRoot` 创建根容器
- `useDeferredValue` 用于延迟计算代价高的值
- `Suspense` 用于语法高亮的异步加载（`Markdown.tsx` 中 `<Suspense fallback=...>`）
- 帧调度通过 `throttle(queueMicrotask(onRender), FRAME_INTERVAL_MS)` 控制

---

## 总结

Claude Code 的 UI 系统本质上是**在终端中重建了一个迷你浏览器**：自定义 DOM、Yoga 布局、双缓冲渲染、事件冒泡、文本选择、硬件滚动优化——所有这些在 Web 中理所当然的基础设施，在终端中都需要从零构建。

REPL.tsx 的 5,000 行代码不是"上帝组件"的反模式，而是终端 UI 的**编排枢纽**——在没有路由的终端中，它是唯一的"路由器"。React Compiler 的自动 memoization 确保了这个巨型组件不会成为性能瓶颈。

整个渲染引擎的设计哲学是**避免全屏重画**：通过 blit 复用不变区域、通过 OffscreenFreeze 冻结离屏组件、通过 DECSTBM 利用硬件滚动、通过对象池消除 GC 压力——每一项优化都直接对应终端渲染的一个痛点。
