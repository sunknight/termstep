# 网页型工具「原生视图」加载模式 — 预研方案（未实施）

> 2026-08-27。评估把网页型工具从 iframe 内嵌升级为兼容性更强的「直接加载」模式
> （Tauri v2 子 webview / 原生 WKWebView）。本文只做方案，不含实现。

## 1. 背景与动机

现状（1.5.0）：网页型工具用 `<iframe>` 内嵌，受目标站点响应头约束：

- `X-Frame-Options: DENY/SAMEORIGIN`、`CSP frame-ancestors` 的站点（Google、
  GitHub 等）拒绝被嵌入 → iframe 显示空白，只能靠顶栏「↗ 浏览器」跳出应用兜底。
- iframe 带 `sandbox` 属性（同预览层），能力受限（无下载、弹窗策略受控）。
- iframe 里的历史导航（站内跳转后无法后退）不受控。

目标：网页工具有一个「直接加载」引擎——对目标站点而言是**顶级导航**而非被嵌入，
X-Frame-Options 天然不适用，行为等同在浏览器里打开该站，但视觉上仍嵌在主区。

## 2. 候选方案对比

| 维度 | A. iframe（现状） | B. 子 webview（推荐评估） | C. 独立 WebviewWindow |
|------|------------------|--------------------------|----------------------|
| 拒嵌站点 | ✗ 空白 | ✓ 顶级导航，不受 X-Frame-Options/frame-ancestors 限制 | ✓ |
| 视觉位置 | 主区内（DOM） | 主区内（原生兄弟视图，命令式定位） | ✗ 独立 OS 窗口，不符合「主区内嵌」 |
| 覆盖层协作 | ✓ DOM z-index 天然被编辑器/预览覆盖层盖住 | ✗ 原生视图**永远在主 webview 之上**，覆盖层打开期间必须 hide() | — |
| 布局跟随 | ✓ flex 自动 | ✗ 命令式 setPosition/setSize 同步 | — |
| 浏览器能力 | 受 sandbox 限制 | 完整（下载、右键、缩放、站内导航） | 完整 |
| 切工具保活 | DOM 常驻 | 原生实例常驻 + hide()（需验证 hide 不重载） | 窗口常驻 |
| 平台 | 全平台 | macOS/Windows 正常；Linux(WebKitGTK) 有已知布局 bug——本项目仅 macOS，不受影响 | 全平台 |
| 已知 bug | — | 窗口 maximize/restore 后定位偏移报告（tauri#11170），需实测 | — |

**C 直接否决**（体验不符）；**A 保留为默认**；**B 为新增引擎**。

## 3. Tauri v2 能力核实（已查证）

- Rust：`WebviewWindowBuilder::new(app, "main", …).build()?.add_child(WebviewBuilder::new(label, WebviewUrl::External(url)), LogicalPosition, LogicalSize)`——同窗口多 webview（Multiwebview）是 v2 正式特性。
- JS 侧 `Webview` 类具备全部所需方法：`new Webview(window, label, options)`（挂到已有窗口）、`setPosition/setSize/hide/show/setFocus/close/reparent/setAutoResize/clearAllBrowsingData/setZoom`。
- 远程 URL 直接支持（`WebviewUrl::External`），`data:` 需 feature（不需要）。
- label 合法字符 `a-zA-Z-/:_` —— `web-<uuid>`（UUID 含连字符）合法。
- 权限模型：capability 按 window/webview label 匹配。子 webview 用独立 label 且
  不出现在任何 capability → 无 Tauri IPC 访问（安全面等同浏览器开该站）。**需实测
  确认**：若现有 `capabilities/default.json` 的 `windows: ["main"]` 会惠及 main 窗口
  内的子 webview，则改为显式 `webviews: ["main"]` 圈定。

## 4. 推荐架构（若实施）

### 4.1 配置与编辑器

- `tool.json` 新增 `webEngine?: 'native'`（缺省 = 现状 iframe）。**不复用旧 `type`、
  也不并入 `kind`**——`kind` 表达「是不是网页工具」，`webEngine` 表达「用哪种引擎加载」，
  正交演进。
- 编辑器网页区加「加载方式」radio：内嵌（默认）/ 原生视图；原生旁配 ? 提示
  「拒嵌站点（GitHub/Google 等）选这个；原生视图是独立浏览器上下文，与内嵌的
  登录态不互通」。
- shared 层（types/toolConfig/toolJson/editorDraft）+ Rust 对偶（types/pure）照
  1.5.0 的 kind/webUrl 模式四步走。

### 4.2 Rust：WebviewPool + 五个 IPC 命令（薄命令层，keyed by toolId）

复用 pty 池的思路，`State<WebviewPool>`（`Mutex<HashMap<String, Webview>>`）：

| 命令 | 行为 |
|------|------|
| `webview:open` (toolId, url, x, y, w, h) | 懒创建：`web-<toolId>` label、External URL、`add_child`；已存在则 no-op |
| `webview:setBounds` (toolId, x, y, w, h) | 位置/尺寸同步（Logical 坐标） |
| `webview:setVisible` (toolId, visible) | hide/show（不销毁，状态保留） |
| `webview:navigate` (toolId, url) | 换 URL（刷新/改配置）：close + 重建（显式刷新语义下重建最稳） |
| `webview:close` (toolId) | 销毁（删工具 / 改回默认型 / 改回内嵌引擎时） |

- `autoResize` 关闭——位置完全由前端驱动，避免与 maximize/restore 的自动行为叠加。
- 可选加固：`on_navigation` 拦截非 `http(s)` 导航（`file://` 等）。
- app 退出时统一 close（对齐 pty kill_all）。

### 4.3 前端：WebPane 双引擎

- `webEngine === 'native'` 的工具：`.web-view` 里渲染**透明占位 div**（保持 flex
  布局结构与 ResizeObserver），用其 `getBoundingClientRect()` 驱动 `setBounds`：
  - 坐标换算：rect（CSS 逻辑像素，视口系）→ 窗口客户区坐标。macOS 上主 webview
    即窗口客户区，需扣菜单栏/标题栏偏移并用 `devicePixelRatio` 折算——**实测校准，
    封装成唯一换算函数**。
  - ResizeObserver + rAF 节流；窗口 resize、侧栏折叠/拖宽、工具切换全部走同一条
    同步路径（占位 div 的 rect 变化天然汇总了所有布局源）。
- 激活/切走：`setVisible(true/false)`；首次激活才 `open`（懒创建，对齐 pty）。
- **覆盖层互斥**（关键）：`overlayOpen`（编辑器/预览覆盖层）期间对全部 native
  webview `setVisible(false)`，关闭后恢复——否则原生视图盖住 DOM 覆盖层。同理
  逐个检查会浮在主区上方的浮层（侧栏折叠 Peek 几何上不重叠，可不处理；要逐一
  核对 z 序）。
- 刷新按钮：native → `webview:navigate(configUrl)`；iframe → 现状 key 重挂载。
- 工具删除/改型/改引擎：prune effect 里 `webview:close`（对齐 pty.kill 的
  webKilledRef 模式）。

## 5. 风险与验证清单（实施前必须逐项过）

1. **z-order**：子 webview 盖 DOM 覆盖层 → overlayOpen 互斥已纳入方案；实测编辑器
   开关、预览开关、Esc 关闭路径。
2. **坐标同步精度**：拖窗缩放 / maximize-restore（tauri#11170）/ 侧栏折叠拖宽 /
   切工具，四场景 rect 跟手无残影；hide 期间 bounds 变化要在 show 前补一次同步。
3. **hide() 保活**：hide→show 后页面状态（登录、输入）应保留、不重载（WKWebView
   预期保活，实测确认）。
4. **存储边界**：各 native webview 间 cookie/localStorage 是否共享（wry 默认
   WKWebsiteDataStore 预期共享 persistent store）；与主应用 origin（tauri.localhost）
   无交集；与 Safari 独立。若需隔离，wry 层有 per-webview data store 能力可再评估。
5. **弹窗/下载**：`target=_blank`、`window.open`、文件下载在 wry 的默认行为待实测
   （可能同视图导航或忽略）；若需「弹窗走系统浏览器」，查 wry new-window 回调支持度
   再排期。
6. **多实例资源**：每个 webview 独立 WKWebView 进程，多网页工具并存内存上涨——
   懒创建策略缓解；数量多时可评估 inactive 超时销毁（会牺牲保活，默认不做）。
7. **IPC 隔离实证**：native webview 页面内确认无 `__TAURI_INTERNALS__`/invoke 能力。

## 6. 实施步骤（若排期，预估 1 个任务轮）

1. Rust：WebviewPool + 5 命令 + lib.rs 注册 + capabilities 核查（IPC 四步）。
2. 前端：WebPane 双引擎 + 占位 div/bounds 同步 + 覆盖层互斥 + prune/close。
3. 配置：`webEngine` 字段全链（shared + Rust 对偶 + 编辑器 radio + 测试）。
4. 冒烟：拒嵌站点（github.com）加载成功、切换保活、刷新、覆盖层互斥、删除销毁、
   maximize/restore 定位。
5. 文档：README（加载方式说明）、AGENTS.md §新增模块要点。

## 7. 结论

- 子 webview 是唯一能**根治拒嵌**的嵌入方案，Tauri v2 API 齐备、macOS 路径成熟；
  成本集中在「命令式布局同步」与「覆盖层互斥」两处，逻辑集中可控。
- 建议以 **`webEngine` 按工具 opt-in** 落地（默认仍 iframe）：有拒嵌需求的工具选
  原生，其余不动；观察稳定后可讨论把默认翻转为 native（届时 iframe 引擎降级为
  兼容选项或移除）。

## 参考

- [Tauri v2 WebviewBuilder (docs.rs)](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)
- [Tauri v2 JS webview API](https://v2.tauri.app/reference/javascript/api/namespacewebview/)
- [Tauri 2.0 Beta 公告（Multiwebview 特性）](https://v2.tauri.app/blog/tauri-2-0-0-beta/)
- [wry（底层 WebView 库）](https://github.com/tauri-apps/wry)
- [tauri#11170 maximize/restore 定位问题](https://github.com/tauri-apps/tauri/issues/11170)
- [tauri#2975 同窗口多 webview 原始需求与示例](https://github.com/tauri-apps/tauri/issues/2975)
- [Linux 多 webview 布局问题（本项目不受影响，仅记录）](https://www.reddit.com/r/tauri/comments/1qxfkeu/multiwebview_breaks_layout_on_linux_webkitgtk/)
