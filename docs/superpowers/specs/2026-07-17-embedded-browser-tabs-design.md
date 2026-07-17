# 内嵌浏览器 + 统一 Tab 栏 设计

> 日期：2026-07-17
> 状态：设计待评审
> 版本目标：0.9.3+

## 1. 目标

在中间终端区域引入**统一 tab 栏**，使每个工具的终端与若干「网页 tab」（iframe）混排在同一个 tab 切换系统里。用户在右侧帮助页点击 http(s) 链接时，网页在中间区域的网页 tab 内打开，而不是跳到系统浏览器。

核心需求：
1. 中间区域可浏览网页（iframe 承载）；
2. 支持多 tab 浏览，**终端 tab 与网页 tab 在同一 tab 栏混排**；
3. 每个网页 tab 提供「在默认浏览器打开」按钮（原始需求）。

## 2. 技术选型与可行性结论

### 2.1 选 iframe，不选 webview

评估过的方案（见 §8 对比表）：iframe、Tauri child webview、独立窗口 webview、代理剥离头、wry+objc。

**选定 iframe**。理由：
- **「和终端共用 tab」只在 iframe 方案下可行**——iframe 与 xterm 终端都是 DOM 元素，能在同一个 tab 栏自然切换；webview 是原生视图，显隐/定位是另一套机制，与 DOM 终端混排切换极其困难。
- 稳定：iframe 是标准 web 元素，布局随主窗口响应，无 `unstable` feature 依赖。
- 零新 Rust 依赖。

### 2.2 已知固有边界（iframe 限制，用户已知情接受）

部分网站通过 `X-Frame-Options` / CSP `frame-ancestors` 拒绝被嵌入（典型：GitHub、Google、多数带登录态的站点）。这些站点无法真正内嵌，会落到 §4.3 的「拒绝嵌入」提示卡片，由用户手动「在默认浏览器打开」。**这是 iframe 方案的固有权衡，不可消除。**

其他 iframe 跨源安全限制：
- 读不到 iframe 内部当前 URL（点击链接跳转后我们记录的 URL 不更新，只能记录「我们主动导航到的 URL」）；
- 读不到 iframe 内部 DOM / 标题；
- 无法做后退/前进（`contentWindow.history` 跨源受限）。

因此网页 tab 工具栏**极简**：仅标题（初始 URL 的 host）+ 「在默认浏览器打开」+ 关闭按钮。

## 3. 架构

### 3.1 tab 模型

中间区域顶部新增**统一 tab 栏**（新组件 `TabBar`）。tab 分两类：

- **终端 tab（单数）**：每个工具的第 1 个 tab，永远存在，不可关闭。内容是当前工具的 xterm 终端（`TerminalView`，按 `activeId` 切换）。跟随左侧工具列表选中变化。
- **网页 tab（复数，iframe）**：点帮助页链接时新建。**绑定到打开它的工具**：`Record<toolId, WebTab[]>`。

### 3.2 状态

新增（在 `App.tsx`）：

```ts
interface WebTab {
  id: string;          // UUID，tab 唯一标识
  url: string;         // 主动导航到的 URL（不随 iframe 内跳转更新）
  title: string;       // 初始：URL host；后续无更新（跨源读不到标题）
  rejected?: boolean;  // 检测到拒绝嵌入后置 true，显示提示卡片
}

// 每个工具独立的网页 tab 列表
const webTabsByTool: Record<string, WebTab[]>;   // keyed by toolId
// 当前激活的 tab：'terminal' | webTabId
const activeTabId: Record<string, 'terminal' | string>;  // keyed by toolId
```

切工具时：读 `webTabsByTool[newToolId]` 与 `activeTabId[newToolId]`（缺省 `'terminal'`），渲染对应 tab。

### 3.3 数据流

```
HelpPane 点 http(s) 链接
  → e.preventDefault()
  → 新建 WebTab{url}，push 到 webTabsByTool[activeToolId]
  → activeTabId[activeToolId] = webTab.id
  → 渲染切到该网页 tab（终端 display:none，iframe 显示）
```

终端 tab 与网页 tab 的显隐**复用现有 `display:none` 切换模式**（`TerminalView.tsx:200` 的模式）：所有终端常驻 DOM，网页 tab 的 iframe 按需挂载/卸载（关闭 tab 时卸载，避免后台 iframe 占资源）。

### 3.4 不改的

- 终端懒加载、`termRegistry`、pty 生命周期、generation guard（§6.3）全部保留。
- 「在默认浏览器打开」复用现有 `open_external` 命令（`commands.rs:565`）与 `api.shell.openExternal`。
- 不引入新 Rust 依赖。iframe 是纯渲染端。

## 4. 组件设计

### 4.1 `TabBar`（新）

中间区域顶部，`.term-header` 下方、`.term-pane-wrap` 上方。

```
┌──────────────────────────────────────────┐
│ term-header（现有，不动）                 │
├──────────────────────────────────────────┤
│ [💻 终端] [🌐 host1 ×] [🌐 host2 ×]       │  ← TabBar（新）
├──────────────────────────────────────────┤
│                                          │
│   终端 或 iframe（按 activeTabId 二选一） │
│                                          │
└──────────────────────────────────────────┘
```

- 终端 tab：固定在最左，标签为「💻 终端」或工具图标+名，不可关闭（无 ×）。
- 网页 tab：标签为 `🌐` + URL host，右侧 × 关闭。
- 没有 + 按钮（新建 tab 只通过点链接触发）。

### 4.2 `WebPane`（新）

单个网页 tab 的内容区。

```
┌──────────────────────────────────────────┐
│ 🔗 host.example.com        ↗ 在浏览器打开 │  ← 极简工具栏
├──────────────────────────────────────────┤
│                                          │
│        <iframe src={url}>                │
│                                          │
└──────────────────────────────────────────┘
```

- 工具栏：左侧 URL（只读显示，不可输入）+ 右侧「↗ 在浏览器打开」按钮（调 `api.shell.openExternal(url)`）。
- 无后退/前进/刷新/地址栏输入。

### 4.3 iframe 拒绝嵌入的检测与提示

iframe 拒绝嵌入（`X-Frame-Options: deny` / CSP `frame-ancestors`）时，浏览器**不会抛 JS 错误**，只是显示空白。检测策略：

1. iframe `onLoad` 触发后，启动一个短超时（如 2.5s）。
2. 超时内若能读到 `contentDocument`（同源）且 body 非空 → 正常，取消超时。
3. 超时到仍读不到内容（跨源）或读到的 `contentDocument` 为空 → **不直接判定拒绝**（跨源正常加载也读不到）。这是 iframe 检测的固有难点。

**务实方案**：不做「自动判定拒绝」（跨源正常与被拒无法可靠区分），改为**始终保留 iframe + 始终显示「在浏览器打开」按钮**。用户自己发现打不开时点按钮。与用户选择的「提示 + 外部打开按钮」一致——提示以「按钮常驻」的形式存在，而非自动弹卡片。

> 备选（若后续要更主动的提示）：维护一个已知会拒绝嵌入的 host 黑名单（GitHub、Google 等少数大站），命中时直接显示提示卡片。作为 v2 增强项，不在首版实现。

### 4.4 `HelpPane` 链接拦截改动

`HelpPane.tsx:181-191` 现有逻辑：

```ts
if (/^(https?:|mailto:)/i.test(href)) {
  e.preventDefault();
  void api.shell.openExternal(href);  // ← 改这里
}
```

改为调用新的 tab 创建回调（由 `App.tsx` 注入 prop）：

```ts
if (/^https?:/i.test(href)) {
  e.preventDefault();
  props.onOpenLink(href);  // 新建网页 tab
} else if (/^mailto:/i.test(href)) {
  e.preventDefault();
  void api.shell.openExternal(href);  // mailto 仍走系统
}
```

## 5. 交互细节

| 场景 | 行为 |
|------|------|
| 点帮助页 http(s) 链接 | 新建网页 tab + 自动切换到该 tab |
| 点网页 tab 标签 | 切换到该 tab（终端 display:none） |
| 点终端 tab 标签 | 切回终端（网页 tab 的 iframe 卸载或保留在 DOM 隐藏） |
| 点网页 tab 的 × | 关闭该 tab，若它是激活 tab 则切回终端 tab |
| 切换左侧工具 | 保留各自网页 tab；新工具若无网页 tab 则默认显终端 tab |
| 点「在浏览器打开」 | `api.shell.openExternal(url)`，不影响 tab |
| 应用重启 | 网页 tab 清空（不持久化） |

iframe 卸载策略：网页 tab 非激活时**保留 iframe 在 DOM（隐藏）**，仅关闭 tab 时卸载。理由：切 tab 来回时重新加载 iframe 体验差（重新加载慢、丢失滚动位置）。代价是后台 iframe 仍占资源——可接受（用户主动开的）。

## 6. 安全

### 6.1 CSP 改动

`tauri.conf.json` 当前 CSP 的 `frame-src` 回落 `default-src 'self'`，外部 iframe 会被拦。需加：

```
frame-src 'self' https: http:;
```

（`http:` 也放行——用户选择「不限制 URL」，可能访问 localhost dev server。）

### 6.2 URL 限制

按用户决策**不限制 URL**。理由：iframe 跨源读不到内部内容，诱导访问内网的风险有限（攻击者读不到结果）。`javascript:`/`data:` 仍由 `HelpPane` 现有拦截挡住（只放行 `http(s)`）。

### 6.3 不新增 SSRF 守卫

iframe 加载不经 Rust fetch（浏览器直接请求），现有 `tools.rs` 的 SSRF 守卫（针对 `fetch_remote_markdown`）不适用。无需改动。

## 7. 模块改动清单

| 文件 | 改动 |
|------|------|
| `src/renderer/App.tsx` | 新增 `webTabsByTool`/`activeTabId` 状态；中间区域渲染 `TabBar`；按 `activeTabId` 切换终端/`WebPane`；向 `HelpPane` 注入 `onOpenLink` |
| `src/renderer/components/TabBar.tsx`（新） | tab 栏 UI |
| `src/renderer/components/WebPane.tsx`（新） | 单个网页 tab：极简工具栏 + iframe |
| `src/renderer/components/HelpPane.tsx` | `HelpPane.tsx:185-187` 改为 `props.onOpenLink(href)` |
| `src/renderer/styles.css` | `TabBar` / `WebPane` / `.tab` 样式 |
| `src-tauri/tauri.conf.json` | CSP 加 `frame-src 'self' https: http:` |

**不改**：`commands.rs`、`pty.rs`、`lib.rs`、`TerminalView.tsx`、`termRegistry.ts`、任何 Rust 后端。

## 8. 备选方案对比（评估记录）

| 方案 | 中间区域 | 任意网站 | 稳定性 | 共用 tab | 取舍 |
|------|:--:|:--:|:--:|:--:|------|
| **iframe（选定）** | ✅ | 部分 | ⭐⭐⭐⭐⭐ | ✅ | 部分站点拒嵌，外部打开兜底 |
| child webview | ✅ | ✅ | ⭐ unstable | ❌ | macOS 定位受限，white-on-load bug |
| 独立窗口 webview | ❌ 浮动 | ✅ | ⭐⭐⭐⭐ | ❌ | 不在中间区域 |
| 代理剥离头 | ✅ | ✅* | ⭐⭐ | ✅ | 工程量极大，等于重写浏览器 |
| wry+objc | ✅ | ✅ | ⭐ unsafe | ❌ | 绕过 Tauri，维护噩梦 |

\* 代理方案的「任意」伴随无尽兼容性 bug（cookie/OAuth/CSP nonce/SRI）。

## 9. 不做（YAGNI）

- 后退/前进/刷新/地址栏输入（iframe 跨源受限，体验差）。
- 网页 tab 跨重启持久化（定位为临时预览）。
- URL 黑/白名单与 SSRF 守卫（iframe 不经 Rust fetch）。
- 已知拒嵌 host 黑名单（v2 增强项，首版不做）。
- 多终端 tab（用户选了单终端 tab 语义）。
- 浏览器历史/书签/下载。
