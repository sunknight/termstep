# 弹层式网页浏览 + 文档预览 设计

> 日期：2026-07-18（定稿）
> 状态：待实施
> 版本目标：0.9.3+
> **本方案替代** `2026-07-17-embedded-browser-tabs-design.md`（tab 方案，搁置）。

## 1. 目标

用**弹层（modal overlay）**方式实现预览，复用现有 `.modal-overlay` + `.modal` 模式。**入口统一为工具文档（help.md）里的标准 markdown 链接**——零新语法，用户在 help.md 里正常写 `[文本](url或路径)`，点击时按链接类型自动路由到弹层预览：

1. **网页浏览**：http(s) 链接（非文档后缀）→ 弹层 iframe 打开。
2. **文档预览**（远程与本地统一复用现有 `fetch_md_preview`）：
   - 远程文档（http(s) 且 `.md`/`.markdown`/`.txt` 结尾）→ 直接传 URL。
   - 本地文档（相对/绝对路径，文档后缀结尾）→ 前端基于工具 cwd 解析为绝对路径后传入。
   - `fetch_md_preview`（后端 `fetch_remote_markdown`）已内置：本地路径分支 + 敏感守卫 + 扩展名白名单 + 2 MiB 上限，无需新 IPC。

核心需求：
- 弹层形态（全屏居中大卡，非中间区域改造，非独立浮动窗口）。
- 「在默认浏览器打开」按钮（网页场景的兜底）。
- md + txt 起步，docx / pdf 作为后续增强。

## 2. 关键决策与权衡

### 2.1 网页用 iframe，不用 webview

评估过三条路线：

| 路线 | 能开任意网站 | 是"弹层"形态 | 工程量 | 与文档预览统一 |
|------|:---:|:---:|:---:|:---:|
| **A 弹层 + iframe（选定）** | ❌ 拒嵌站点打不开 | ✅ | 小 | ✅ |
| B 独立 Tauri 窗口 webview | ✅ | ❌ 浮动窗口 | 中 | ❌ |
| C 主窗口内嵌 child webview | ✅ | ✅ | **unstable API，排除** | ✅ |

**选定 A**。B 虽能力最强（真 WKWebView，能开 GitHub/Google），但**不是弹层**——是带标题栏、进 dock、可独立最小化的浮动窗口，违背"弹层"语义，且与文档预览割裂。C 是 unstable feature，生产级风险过高，排除。

**A 的固有权衡（已知情接受）**：部分网站通过 `X-Frame-Options` / CSP `frame-ancestors` 拒绝嵌入 iframe（典型：GitHub、Google、带登录态站点）。这些站点在弹层显示空白，靠工具栏常驻「在默认浏览器打开」按钮兜底。

iframe 跨源限制：读不到内部 URL / 标题 / DOM，无后退 / 地址栏。因此网页工具栏**极简**。

### 2.2 文档预览首版 md + txt，docx / pdf 后续

| 格式 | 方案 | 何时做 |
|------|------|--------|
| md | `md.render()`（markdown-it 已在用） | 首版 |
| txt | `<pre>` | 首版 |
| docx | `mammoth.js`（渲染端） | 后续 |
| pdf | `pdf.js`（~2MB） | 后续 |

文档预览不受 iframe/webview 之争影响——内容本地渲染后塞进弹层，无拒嵌问题。

### 2.3 入口：标准 markdown 链接，零新语法

不在 help.md 引入新围栏/语法。用户直接写标准链接，类型由 href 形式自动判断（见 §3.2）。这样 help.md 保持纯 markdown，可移植、可读。

### 2.4 本地路径相对工具 cwd 解析

相对路径（如 `./README.md`、`docs/guide.md`）**相对于工具的 cwd**（工具配置的工作目录，`tool.cwd`）解析。理由：TermStep 工具常针对某项目，引用项目内 README/文档是高频场景。

- 绝对路径（`/` 或 `~` 开头）按绝对路径处理。
- 远程（http(s)）路径不受此规则影响。

## 3. 架构

### 3.1 一个统一的预览弹层组件

新增 `PreviewOverlay`（覆盖 z-index 300，与现有 modal 同层）。根据传入内容类型切换 body：

```
PreviewOverlay
├── kind: 'web'   → 工具栏(仅 URL + 在浏览器打开) + <iframe src=url>
├── kind: 'md'    → md.render(content)（复用 markdown.ts）
└── kind: 'txt'   → <pre>{content}</pre>
```

单视图，一次预览一个内容。关掉再开下一个。

### 3.2 链接类型自动判断（核心路由逻辑）

在 `HelpPane` 的点击拦截里，对 `http(s)` 和本地路径链接做分流。判断顺序：

| href 形式 | 判断依据 | 行为 |
|-----------|----------|------|
| `mailto:` | scheme | 系统（现有，不动） |
| `http(s)` 且 URL pathname 以 `.md`/`.markdown`/`.txt` 结尾 | 后缀 | **远程文档预览**：`fetch_md_preview`（已有）→ md.render |
| `http(s)` 其他 | scheme | **网页预览**：iframe |
| 本地路径（非 http(s)）且以文档后缀结尾 | 后缀 | **本地文档预览**：前端基于 cwd 解析为绝对路径 → `fetch_md_preview`（复用）→ md.render |
| 本地路径其他后缀 | 后缀 | 弹层提示"暂不支持该类型" |
| 其他 scheme | — | 阻止（现有，防 `javascript:`/`data:`） |

文档后缀白名单（首版）：`md` / `markdown` / `txt`。

### 3.3 状态

在 `App.tsx` 加顶层 state（与现有 `helpOpen`/`recordsToolId` 同模式）：

```ts
type PreviewState =
  | { kind: 'web'; url: string; title: string }
  | { kind: 'md' | 'txt'; title: string; content: string; error?: string }
  | null;

const [preview, setPreview] = useState<PreviewState>(null);
```

弹层挂载在 App 末尾（与现有 modal 同位置），`null` 时不渲染。

### 3.4 数据流

**网页**：
```
HelpPane 点 http(s) 链接（非文档后缀）
  → e.preventDefault()
  → setPreview({ kind:'web', url:href, title:host })
  → 弹层渲染 iframe
```

**远程文档**：
```
HelpPane 点 http(s) 链接（.md/.txt 后缀）
  → e.preventDefault()
  → api.tools.fetchMdPreview(url)            // 已有 IPC
  → setPreview({ kind:'md', content, error })
  → 弹层渲染 md
```

**本地文档**（复用现有 `fetch_md_preview`，前端解析 cwd）：
```
HelpPane 点本地路径链接（文档后缀）
  → e.preventDefault()
  → 前端把相对路径基于 tool.cwd 解析为绝对路径（~ 展开、相对转绝对）
  → api.tools.fetchMdPreview(absPath)        // 复用现有 IPC（后端走 is_local_path 分支）
  → setPreview({ kind:'md'|'txt', content, error })
  → 弹层渲染
```

### 3.5 不改的

- 中间终端区域完全不动（相对 tab 方案最大的简化）。
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
│            <iframe> 或 md 渲染 或 <pre>               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

尺寸：`.preview-modal { width: 95vw; max-width: 1400px; height: 90vh }`。大屏沉浸式预览。

工具栏统一：左侧标题（web=URL host，doc=文件名），右侧动作。
- web：右侧「↗ 在浏览器打开」（调 `api.shell.openExternal(url)`）+ ✕。
- md/txt：右侧仅 ✕。加载中显示 spinner，出错显示错误信息（如本地文件不存在/被安全守卫拒绝/超过大小上限）。

### 4.2 iframe 拒绝嵌入的处理

**不做自动检测**（iframe 跨源正常加载与被拒无法可靠区分）。改为**工具栏常驻「在浏览器打开」按钮**兜底。用户发现打不开时点按钮转系统浏览器。

> 备选（v2 增强）：维护已知拒嵌 host 黑名单（GitHub、Google 等），命中时显示提示卡。首版不做。

### 4.3 `HelpPane` 链接拦截改动

`HelpPane.tsx:181-191` 现有：

```ts
const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
if (anchor) {
  const href = anchor.getAttribute('href') ?? '';
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    void api.shell.openExternal(href);
  } else {
    e.preventDefault();
  }
}
```

改为按类型路由，调用 `App.tsx` 注入的 `onOpenLink(href)`（具体路由逻辑可在 `App` 内或 `HelpPane` 内，推荐 `HelpPane` 内做判断后调对应回调）：

```ts
if (/^https?:/i.test(href)) {
  e.preventDefault();
  if (/\.(md|markdown|txt)(\?|#|$)/i.test(new URL(href).pathname)) {
    props.onOpenRemoteDoc(href);   // 远程文档预览
  } else {
    props.onOpenWeb(href);         // 网页预览
  }
} else if (/^mailto:/i.test(href)) {
  e.preventDefault();
  void api.shell.openExternal(href);  // mailto 仍走系统
} else if (looksLikeLocalDocPath(href)) {
  e.preventDefault();
  props.onOpenLocalDoc(href);      // 本地文档预览
} else {
  e.preventDefault();              // 其余阻止导航
}
```

`looksLikeLocalDocPath`：非 http(s)/mailto，且以 `md`/`markdown`/`txt` 结尾（忽略尾部 `#anchor`/`?query`）。

## 5. 复用现有 `fetch_md_preview`，后端零改动

### 5.1 关键发现：本地路径已被支持

`fetch_remote_markdown`（`tools.rs:235`）已内置本地路径分支（`is_local_path`）：
- **敏感文件守卫**：`sensitive_path_reason`（`tools.rs:179`）挡凭据/系统文件。
- **扩展名白名单**：`is_allowed_local_md`（`tools.rs:67`，`["md","markdown","txt"]`）。
- **本地读取**：`tokio::fs::read_to_string`。
- 远程另含 SSRF 守卫 + 禁重定向 + 2 MiB 上限 + 8s 超时。

因此本地文档预览**无需新 IPC**。前端只需把相对路径基于工具 cwd 解析为绝对路径（含 `~` 展开），传入 `api.tools.fetchMdPreview`。

### 5.2 路径解析（前端）

```ts
function resolveDocPath(href: string, cwd: string | undefined): string {
  if (href.startsWith('~/') || href === '~') {
    return href;  // 后端 sensitive_path_reason 会展开 ~（但 ~ 通常非文档后缀，会被拒；约定不用 ~）
  }
  if (href.startsWith('/')) return href;  // 绝对路径原样
  // 相对路径：基于 cwd 拼接
  const base = cwd || '';
  if (!base) return href;  // 无 cwd 无法解析，原样传（大概率读不到，报错）
  // 简单拼接 + 规整 ./ ../（避免引入 path 库，用 URL 或手写）
  ...
}
```

约定：不处理 `~`（文档极少放 home 根，且后端守卫会拒）。绝对路径原样。相对路径基于 cwd 拼接。

### 5.3 不新增 IPC 契约

无需改 `types.ts` / `commands.rs` / `lib.rs` 的 IPC 契约。仅 `tauri.conf.json` 的 CSP 改动（§7.1）。

## 6. 交互细节

| 场景 | 行为 |
|------|------|
| 点 http(s) 文档后缀链接 | 弹层打开，显示加载中 → fetch_md_preview → md 渲染 |
| 点 http(s) 网页链接 | 弹层打开，iframe 加载 |
| 点本地文档链接 | 弹层打开，加载中 → read_doc_file → md/pre 渲染 |
| 点弹层 ✕ / Esc / 点背景 | 关闭弹层，iframe/内容卸载 |
| 点「在浏览器打开」 | `api.shell.openExternal(url)`，弹层不关 |
| iframe 被拒嵌 | 空白 + 工具栏常驻「在浏览器打开」兜底 |
| 本地文件不存在 / 超大 / 被守卫拒 | 弹层显示错误信息 |
| 一次只预览一个内容 | 换内容先关再开 |

## 7. 安全

### 7.1 CSP 改动

`tauri.conf.json` 的 `frame-src` 当前回落 `default-src 'self'`，外部 iframe 被拦。需加：

```
frame-src 'self' https: http:;
```

（`http:` 放行以支持 localhost dev server 文档。）

### 7.2 URL 不限制

iframe 加载不经 Rust fetch（浏览器直接请求），SSRF 守卫不适用。`javascript:`/`data:` 由 HelpPane 拦截挡住（只放行 http(s) 和本地文档路径）。iframe 跨源读不到内容，诱导访问内网风险有限。

### 7.3 本地文档读取的安全姿态

见 §5.2，复用全套守卫。远程文档复用现有 `fetch_remote_markdown`（已含 SSRF 守卫 + 大小上限 + 禁重定向）。

## 8. 模块改动清单

| 文件 | 改动 |
|------|------|
| `src/renderer/App.tsx` | 加 `preview` state + 末尾渲染 `PreviewOverlay`；向 `HelpPane` 注入 `onOpenWeb`/`onOpenDoc` |
| `src/renderer/components/PreviewOverlay.tsx`（新） | 统一预览弹层：web/md/txt 三种 body + 极简工具栏 + 加载/错误态 |
| `src/renderer/components/HelpPane.tsx` | `HelpPane.tsx:181-191` 改为按类型路由（http 文档/http 网页/mailto/本地文档），本地路径基于 cwd 解析 |
| `src/renderer/styles.css` | `.preview-modal` 尺寸 + iframe/md/pre body 样式 |
| `src-tauri/tauri.conf.json` | CSP 加 `frame-src 'self' https: http:` |

**不动**：`pty.rs`、`TerminalView.tsx`、`termRegistry.ts`、中间终端区域、终端切换逻辑、`commands.rs`、`tools.rs`、`lib.rs`、`types.ts`、`api.ts`（本地/远程文档完全复用 `fetch_md_preview`）。

## 9. 与被替代的 tab 方案的对比

| 维度 | tab 方案（搁置） | 本弹层方案 |
|------|------------------|-----------|
| 改中间区域 | ✅ 大改（引入 tab 抽象） | ❌ 不改 |
| 改终端切换逻辑 | ✅（统一 tab 收口） | ❌ |
| 新抽象 | tab 模型 + webTabsByTool | 单个 preview state |
| 入口 | 点帮助页链接 | 点帮助页链接（同） |
| 文档预览 | 无 | ✅ md/txt 起步，远程+本地 |
| 网页能力 | iframe（同） | iframe（同） |
| Rust 改动 | 仅 CSP | CSP + 1 新 IPC（read_doc_file） |

弹层方案改动面集中在边缘增量（新 modal + 1 IPC），**不碰核心终端架构**，风险更低；且额外获得文档预览能力。

## 10. 不做（YAGNI）

- 多 tab（弹层是单视图）。
- 网页的后退/前进/地址栏（iframe 跨源受限）。
- docx / pdf 首版（后续增强）。
- 已知拒嵌 host 黑名单（v2 增强）。
- 顶栏「预览文件」按钮 + 文件选择器（入口改为 markdown 链接，更自然）。
- 拖拽文件预览。
- 多个内容同时预览。
- 预览历史 / 最近文档列表。
- 新 markdown 语法/围栏（用标准链接，类型自动判断）。
