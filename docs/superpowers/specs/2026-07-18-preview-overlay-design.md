# 弹层式网页浏览 + 文档预览 设计

> 日期：2026-07-18
> 状态：设计待评审
> 版本目标：0.9.3+
> **本方案替代** `2026-07-17-embedded-browser-tabs-design.md`（tab 方案，搁置）。

## 1. 目标

用**弹层（modal overlay）**方式实现两类预览，复用现有 `.modal-overlay` + `.modal` 模式：

1. **网页浏览**：帮助页点 http(s) 链接 → 弹层内用 iframe 打开，不再跳系统浏览器。
2. **文档预览**：预览本地 md / txt 文件（首版）；docx / pdf 作为后续增强。

核心需求：
- 弹层形态（全屏居中大卡，非中间区域改造，非独立浮动窗口）；
- 「在默认浏览器打开」按钮（网页场景的兜底）；
- md + txt 起步，docx / pdf 后续。

## 2. 关键决策与权衡

### 2.1 网页用 iframe，不用 webview

评估过三条路线：

| 路线 | 能开任意网站 | 是"弹层"形态 | 工程量 | 与文档预览统一 |
|------|:---:|:---:|:---:|:---:|
| **A 弹层 + iframe（选定）** | ❌ 拒嵌站点打不开 | ✅ | 小 | ✅ |
| B 独立 Tauri 窗口 webview | ✅ | ❌ 浮动窗口 | 中 | ❌ |
| C 主窗口内嵌 child webview | ✅ | ✅ | **unstable API，排除** | ✅ |

**选定 A**。B 虽然能力最强（真 WKWebView，能开 GitHub/Google），但它**不是弹层**——是带标题栏、进 dock、可独立最小化的浮动窗口，违背"弹层"语义，且与文档预览的弹层机制割裂。C 是 unstable feature，生产级应用风险过高（macOS 定位受限、white-on-load bug），已排除。

**A 的固有权衡（已知情接受）**：部分网站通过 `X-Frame-Options` / CSP `frame-ancestors` 拒绝嵌入 iframe（典型：GitHub、Google、带登录态站点）。这些站点在弹层里显示空白，靠弹层工具栏常驻的「在默认浏览器打开」按钮兜底。

iframe 跨源限制：读不到内部 URL / 标题 / DOM，无后退 / 地址栏。因此网页预览工具栏**极简**。

### 2.2 文档预览首版 md + txt，docx / pdf 后续

| 格式 | 方案 | 何时做 |
|------|------|--------|
| md | `md.render()`（markdown-it 已在用） | 首版 |
| txt | `<pre>` | 首版 |
| docx | `mammoth.js`（渲染端） | 后续 |
| pdf | `pdf.js`（~2MB） | 后续 |

文档预览**不受 iframe/webview 之争影响**——内容是本地渲染后塞进弹层，无拒嵌问题。

## 3. 架构

### 3.1 一个统一的预览弹层组件

新增 `PreviewOverlay`（覆盖 z-index 300，与现有 modal 同层）。它根据传入内容类型切换 body：

```
PreviewOverlay
├── kind: 'web'   → 工具栏(仅 URL + 在浏览器打开) + <iframe src=url>
├── kind: 'md'    → md.render(content) 渲染（复用 HelpPane 的 markdown 渲染逻辑）
└── kind: 'txt'   → <pre>{content}</pre>
```

不一次预览多个：弹层是单视图（不像 tab 方案的多 tab）。关掉再开下一个。

### 3.2 状态

在 `App.tsx` 加一个顶层 state（与现有 `helpOpen`/`recordsToolId` 同模式）：

```ts
type PreviewState =
  | { kind: 'web'; url: string; title: string }   // 网页
  | { kind: 'md' | 'txt'; path: string; content: string; title: string }  // 本地文档
  | null;                                          // 关闭

const [preview, setPreview] = useState<PreviewState>(null);
```

弹层挂载在 App 末尾（与现有 modal 同位置），`preview` 为 null 时不渲染。

### 3.3 数据流

**网页**：
```
HelpPane 点 http(s) 链接
  → e.preventDefault()
  → setPreview({ kind:'web', url:href, title:host })   // 替换原来的 openExternal
  → 弹层渲染 iframe
```

**文档预览**（入口：工具栏「预览文件」按钮，或可选拖拽）：
```
点「预览文件」
  → api.fs.pickDocFile()                    // 复用 rfd，过滤 md/txt
  → 返回 path
  → api.fs.readDocFile(path)                // 新 IPC，读内容（过安全守卫）
  → setPreview({ kind: ext, path, content, title: filename })
  → 弹层渲染 md 或 pre
```

### 3.4 不改的

- 中间终端区域完全不动（这是相对 tab 方案最大的简化）。
- 终端懒加载、pty 生命周期、generation guard（§6.3）全部保留。
- 「在默认浏览器打开」复用现有 `open_external` 命令（`commands.rs:565`）。
- 现有 modal 模式（`.modal-overlay` + `.modal` + Esc 关闭 + 背景点击关闭）照搬。

## 4. 组件设计

### 4.1 `PreviewOverlay`（新）

```
┌──────────────────────────────────────────────────────┐
│ 🔗 example.com/path              ↗ 在浏览器打开  ✕   │ ← 工具栏（极简）
├──────────────────────────────────────────────────────┤
│                                                      │
│                                                      │
│            <iframe> 或 md 渲染 或 <pre>               │
│                                                      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

尺寸：`.preview-modal { width: 95vw; max-width: 1400px; height: 90vh }`。大屏沉浸式预览。

工具栏统一：左侧标题/URL（只读），右侧动作按钮。
- web：右侧「↗ 在浏览器打开」（调 `api.shell.openExternal(url)`）+ ✕。
- md/txt：右侧仅 ✕（无外部打开需求；可后续加「在 Finder 显示」）。

### 4.2 iframe 拒绝嵌入的处理

**与 tab 方案一致：不做自动检测**（iframe 跨源正常加载与被拒无法可靠区分）。改为**工具栏常驻「在浏览器打开」按钮**作为兜底。用户发现打不开时点按钮转系统浏览器。

> 备选（v2 增强）：维护已知拒嵌 host 黑名单（GitHub、Google 等少数大站），命中时在 iframe 区显示提示卡。首版不做。

### 4.3 `HelpPane` 链接拦截改动

`HelpPane.tsx:185-187` 现有逻辑：

```ts
if (/^(https?:|mailto:)/i.test(href)) {
  e.preventDefault();
  void api.shell.openExternal(href);  // ← 改这里
}
```

改为调用 `App.tsx` 注入的 `onOpenLink` 回调：

```ts
if (/^https?:/i.test(href)) {
  e.preventDefault();
  props.onOpenLink(href);              // 打开预览弹层
} else if (/^mailto:/i.test(href)) {
  e.preventDefault();
  void api.shell.openExternal(href);   // mailto 仍走系统
}
```

## 5. 新增 IPC：读本地文档

### 5.1 缺口

现有 `pick_md_file`（`commands.rs:278`）只返回路径不读内容；`fetch_md_preview` 只走远程。预览本地文档需要**新建「读本地文件内容」IPC**。

### 5.2 安全设计（必须复用现有姿态）

新命令 `read_doc_file(path)`：

1. **扩展名白名单**：复用 `allowed_md_extensions()`（`tools.rs:62-64`，当前 `["md","markdown","txt"]`）。docx/pdf 增强时再扩充白名单。
2. **敏感文件守卫**：复用 `sensitive_path_reason`（`tools.rs:39-57` 的黑名单 + `.ssh`/`.aws`/`.kube`/`.gnupg`/`Library/Keychains` 等目录）。
3. **路径穿越校验**：拒绝空串、`/`、`\`、`..`、NUL（与 `validate_tool_id` 同套校验思路）。
4. **大小上限**：读取前 `metadata().len()` 检查，超过如 2 MiB 拒绝（防 OOM；md/txt 极少超此）。
5. **不放宽现有命令**：`fetch_md_preview` 的远程白名单不动，新命令独立。

### 5.3 IPC 契约（遵循 §5.1 四步）

1. `src/shared/types.ts` 加 `IPC.fs.readDocFile: 'fs:readDocFile'`、`IPC.fs.pickDocFile: 'fs:pickDocFile'`。
2. `commands.rs` 加 `#[tauri::command] read_doc_file(path) -> {content, error}`、`pick_doc_file() -> {canceled, path}`。
3. `lib.rs` `generate_handler!` 注册。
4. `api.ts` 加 `api.fs.readDocFile` / `api.fs.pickDocFile`。

## 6. 交互细节

| 场景 | 行为 |
|------|------|
| 帮助页点 http(s) 链接 | 弹层打开，iframe 加载该 URL |
| 点弹层 ✕ / Esc / 点背景 | 关闭弹层，iframe 卸载 |
| 点「在浏览器打开」 | `api.shell.openExternal(url)`，弹层不关 |
| 点「预览文件」按钮（位置待定，顶栏或侧栏） | 弹原生文件选择器（md/txt 过滤）→ 读取 → 弹层渲染 |
| iframe 被拒嵌 | 空白 + 工具栏常驻「在浏览器打开」兜底 |

一次只预览一个内容（web 或 doc）。要换就关掉再开。

## 7. 安全

### 7.1 CSP 改动

`tauri.conf.json` 的 `frame-src` 当前回落 `default-src 'self'`，外部 iframe 被拦。需加：

```
frame-src 'self' https: http:;
```

（`http:` 放行以支持 localhost dev server 文档。）

### 7.2 URL 不限制

iframe 加载不经 Rust fetch（浏览器直接请求），SSRF 守卫不适用。`javascript:`/`data:` 仍由 HelpPane 现有拦截挡住（只放行 `http(s)`）。iframe 跨源读不到内容，诱导访问内网风险有限。

### 7.3 本地文档读取的安全姿态

见 §5.2，复用现有全套守卫。

## 8. 模块改动清单

| 文件 | 改动 |
|------|------|
| `src/renderer/App.tsx` | 加 `preview` state + 末尾渲染 `PreviewOverlay`；顶栏加「预览文件」按钮；向 `HelpPane` 注入 `onOpenLink` |
| `src/renderer/components/PreviewOverlay.tsx`（新） | 统一预览弹层：web(md/txt) 三种 body |
| `src/renderer/components/HelpPane.tsx` | `HelpPane.tsx:185-187` 改为 `props.onOpenLink(href)` |
| `src/renderer/lib/api.ts` | 加 `api.fs.readDocFile` / `api.fs.pickDocFile` |
| `src/shared/types.ts` | 加 `IPC.fs.readDocFile` / `IPC.fs.pickDocFile` |
| `src-tauri/src/commands.rs` | 加 `read_doc_file` / `pick_doc_file` 命令（复用 rfd + 安全守卫） |
| `src-tauri/src/tools.rs` | 复用 `allowed_md_extensions` / `sensitive_path_reason`（可能需小重构为 pub） |
| `src-tauri/src/lib.rs` | `generate_handler!` 注册两个新命令 |
| `src/renderer/styles.css` | `.preview-modal` 尺寸 + iframe/md/pre body 样式 |
| `src-tauri/tauri.conf.json` | CSP 加 `frame-src 'self' https: http:` |

**不动**：`pty.rs`、`TerminalView.tsx`、`termRegistry.ts`、中间终端区域任何代码、终端切换逻辑。

## 9. 与被替代的 tab 方案的对比

| 维度 | tab 方案（已搁置） | 本弹层方案 |
|------|--------------------|-----------|
| 改中间区域 | ✅ 大改（引入 tab 抽象） | ❌ 不改 |
| 改终端切换逻辑 | ✅（统一 tab 收口） | ❌ |
| 新抽象 | tab 模型 + webTabsByTool 状态 | 单个 preview state |
| 网页能力 | iframe（同） | iframe（同） |
| 文档预览 | 无 | ✅ md/txt 起步 |
| 改动文件数 | ~5 | ~10（含 IPC 四步） |
| Rust 改动 | 仅 CSP | CSP + 新 IPC + 安全守卫复用 |

弹层方案改动面虽略多（因加了文档预览的 IPC），但**不碰核心终端架构**，风险更低。

## 10. 不做（YAGNI）

- 多 tab（弹层是单视图）。
- 网页的后退/前进/地址栏（iframe 跨源受限）。
- docx / pdf 首版（后续增强）。
- 已知拒嵌 host 黑名单（v2 增强）。
- 拖拽文件预览（入口先用文件选择器）。
- 多个内容同时预览。
- 预览历史 / 最近文档列表。
