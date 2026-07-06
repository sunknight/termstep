# 检查更新与手动下载（v1）

**日期：** 2026-07-06
**状态：** 设计已批准，待实现

## 目标

TermStep 目前是**未签名**的 macOS Electron 应用，没有任何更新机制。本设计实现「检查更新 + 通知 + 手动下载」——不做自动重启更新（那需要 Apple Developer ID 签名）。用户看到新版本提示后，自行在浏览器下载 DMG、拖装。

## 范围

**做：**
- 启动后静默检查更新（发现新版才提示，不打扰）
- App 菜单「检查更新…」手动触发
- 左侧 sidebar 底部「有新版本」徽章 + popover 详情（更新日志、去下载、稍后再说、再检查）
- 自托管 JSON manifest 作为更新源

**不做（YAGNI）：**
- 自动下载 / 自动安装 / 重启更新（需签名）
- 下载进度条（系统浏览器自带）
- 更新历史、多通道（stable/beta）
- 自动重试 / 定时轮询

## 架构：纯主进程驱动（方案 A）

检查逻辑全放 main 进程：用 `net.fetch` 拉 manifest、`app.getVersion()` 比对版本、状态变化通过现有 IPC `send()` 推送给 renderer 显示。菜单项点击在 main 内直接触发检查。

**为什么：** 契合现有「main 是编排中心」架构（main 已处理 clipboard/pty/文件所有外部交互），网络请求在可信边界内不经过 sandboxed preload，renderer 只负责显示。复杂度最低，且为未来升级到 `electron-updater`（若以后接签名）留干净替换点。

## 第 1 节：更新源 manifest 格式

自托管一个固定 URL 的 JSON（例：`https://yourdomain.com/termstep/update.json`）：

```json
{
  "version": "0.4.0",
  "url": "https://yourdomain.com/termstep/TermStep-0.4.0-arm64.dmg",
  "notes": "修复 Cmd+V 双重粘贴；新增检查更新"
}
```

| 字段 | 说明 |
|------|------|
| `version` | 语义化版本字符串（如 `0.4.0`），与 `package.json` 的 `version` 比对 |
| `url` | DMG 直接下载地址；点徽章/菜单项时用 `shell.openExternal` 在系统浏览器打开 |
| `notes` | 更新日志，展示在徽章 popover 详情里 |

**URL 来源优先级：** `process.env.TERMSTEP_UPDATE_URL` > 代码内默认占位 `https://example.com/termstep/update.json`。开发时可用 `TERMSTEP_UPDATE_URL=http://localhost:8000/update.json npm run dev` 起本地 manifest 测，不改代码。

**版本比较：** 自写 ~15 行 semver 比较（拆 `.` 转 number 逐段比），manifest 版本 > 当前版本才算有更新，不引入新依赖。

## 第 2 节：检查流程与状态管理

### 触发时机

1. **启动自动检查**：`app.whenReady()` 里 `createWindow()` 之后，延迟 ~5 秒发起静默检查（延迟让窗口、pty、工具扫描先跑起来，不抢启动资源）。
2. **手动检查**：App 菜单「检查更新…」项点击立即检查。

### 状态机

主进程内一个模块级状态变量，5 种状态：

```
idle  ──check()──▶  checking  ──manifest 拉到──▶  比对版本
                         │                            │
                         │                       有新版 ─▶ available
                         │                       无新版 ─▶ upToDate
                         │
                         └──网络/解析失败──▶ error（仅 manual 时）/ 保持 idle（静默）
```

- `available` 状态附带 `{ version, url, notes }`。
- `error` 状态附带 `{ error: string }`。
- 状态变化时 main 通过新 IPC 通道 `UPDATE_STATE` 广播给所有窗口。
- **去重**：首次进入 `available` 时把版本号写入 `userData/update-state.json`（存「已通知的版本号」）。启动静默检查时若 manifest 版本 == 已通知版本，不重新置 `available`（避免每次启动重复提示同一版本）。**手动检查不读此标记**——用户主动点了就一定要给反馈。

### 模块边界：`src/main/updater.ts`

导出函数式 API（不建 class，职责太轻）：

| 函数 | 作用 |
|------|------|
| `checkForUpdates(opts: { manual: boolean }): Promise<UpdateState>` | 拉 manifest、比对版本、更新状态、广播 |
| `getUpdateState(): UpdateState` | 同步读当前状态（菜单项 / 初始同步用） |
| `onUpdateState(cb: (s: UpdateState) => void): () => void` | 注册状态回调（main 内部接线广播用） |

**`checkForUpdates` 内部流程：**
1. 若正在 `checking` → 直接返回当前状态（防重入，不并发重复请求）
2. `net.fetch(manifestUrl)` + `AbortController` 10 秒超时
3. JSON 解析 + 字段校验（缺 `version`/`url` → 视为无效 → 错误分支）
4. semver 比对：manifest > 当前 → `available`；否则 `upToDate`
5. 更新状态 → 通知所有 `onUpdateState` 回调 → 回调里由 main 接线广播 `UPDATE_STATE`

**错误处理（按 manual 区分）：**
- `manual=true`：网络错误/JSON 无效/超时/版本格式非法 → 状态设 `error` 并广播（让用户知道失败了，popover 提示）
- `manual=false`（启动静默）：**静默**——状态保持 `idle` 不广播，不打扰用户（离线/断网很常见，不该弹错）

**semver 比较：** 自写（拆 `.` 转 number 逐段比）。非法格式（`abc`、`1.2`、`1.2.3.4` 等）→ 解析失败 → 视为 `error`。

## 第 3 节：IPC 契约、菜单项、徽章 UI

### IPC 契约（遵循现有「types.ts 定义通道常量 → preload 暴露 → main handle」模式）

`src/shared/types.ts` 的 `IPC` 常量新增：

| 通道 | 方向 | 载荷 | 作用 |
|------|------|------|------|
| `UPDATE_STATE` | main → renderer（`send` 推送） | `UpdateState` | 状态变化时广播 |
| `UPDATE_CHECK` | renderer → main（`invoke`） | 无 | 触发一次手动检查 |

`UpdateState` 类型放 `src/shared/types.ts` 并 export：

```ts
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate' }
  | { status: 'available'; version: string; url: string; notes: string }
  | { status: 'error'; error: string };
```

`src/preload/index.ts` 的 `api` 新增：

```ts
update: {
  onState: (cb: (s: UpdateState) => void) => { /* ipcRenderer.on(UPDATE_STATE) */ return offFn },
  check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
},
```

### App 菜单（`menu.ts`）

在「视图」菜单顶部插入一项：

```
视图
  ├── 检查更新…        ← 点击调 checkForUpdates({ manual: true })
  ├── ──────────
  ├── 重新加载
  ...
```

菜单项 `click` 回调在 main 进程直接调 `updater.checkForUpdates({ manual: true })`，不经过 renderer。`UPDATE_CHECK` IPC 仅供徽章 popover 的「再检查」按钮用，保持 API 完整。

### 徽章 UI（renderer）

**位置：** 左侧 sidebar 的 `<nav class="sidebar">` 内、`.sidebar-io`（导入导出按钮区）下方，新增 `.update-badge` 元素。

**显示规则：**
- `available` 状态：显示「✦ 有新版本」文字徽章。
- 其他状态：不显示徽章。

**popover（点击/ hover 徽章时展开）：**

```
┌─────────────────────────┐
│  ✦ 新版本 v0.4.0        │
│  ───────────────────    │
│  修复 Cmd+V 双重粘贴…   │  ← notes（多行可滚动）
│  ───────────────────    │
│  [去下载]  [稍后再说]   │
│                 再检查  │  ← 小字链接
└─────────────────────────┘
```

- 「去下载」：调 `shell.openExternal(url)` 在系统浏览器打开 DMG。
- 「稍后再说」：关闭 popover（红点保留；下次启动不再为此版本重复弹——靠去重标记）。
- 「再检查」：调 `api.update.check()`，触发一次手动检查。
- `upToDate` / `error` 状态：不显示徽章。**手动检查后**的结果用 popover 临时反馈一次（如「已是最新版本」/「检查失败，请稍后重试」），3 秒后自动消失。

**新组件 / hook：**
- `src/renderer/components/UpdateBadge.tsx`：自管理 popover 开闭；`available` 时渲染徽章。
- `src/renderer/hooks/useUpdateState.ts`：订阅 `api.update.onState`，初值向 main 同步查一次（通过初始广播或 `getUpdateState` 等价 IPC；见下「初值同步」）。

**初值同步：** renderer 启动时 main 主动广播一次当前状态（在 `createWindow` 的 `webContents` ready 后），或 renderer mount 时主动调 `api.update.check()`（但不该一 mount 就触发网络）。**采用前者**：main 在 `createWindow` 后 + 每次 `onUpdateState` 时广播；renderer hook 初值用 `{ status: 'idle' }`，收到广播即更新。

## 第 4 节：测试、边界情况、错误处理

### 边界情况与错误处理

| 场景 | 处理 |
|------|------|
| 无网络 / manifest URL 404 / DNS 失败 | `manual=false`：静默，状态留 `idle`。`manual=true`：状态 `error`，popover 提示「检查失败，请稍后重试」 |
| manifest 非 JSON / 缺 `version`/`url` | 同上：视为 `error`（手动时提示） |
| manifest `version` 格式非法（如 `abc`） | semver 解析失败 → 视为 `error` |
| 请求超时（>10s） | `AbortController` 取消，归入错误分支 |
| manifest 版本 ≤ 当前版本 | `upToDate`（手动检查时 popover 反馈「已是最新版本」） |
| 用户离线启动 | 启动静默检查失败，无任何 UI 反馈——符合「不打扰」 |
| 同一版本重复启动 | 去重标记：启动检查时若 manifest 版本 == 已通知版本，不重新置 `available`（手动检查不受此限） |
| dev 模式（`!app.isPackaged`） | **照常检查**——便于测试；版本比对走 `package.json` 的 `version` |

### 测试策略（遵循现有 vitest 模式）

新建 `tests/updater.test.ts`，重点测**纯函数**，网络用注入的 fetch mock：

1. **semver 比较**（核心逻辑，多组用例）：
   - `0.4.0 > 0.3.0` ✓
   - `0.3.0 == 0.3.0`（不算更新）
   - `0.2.0 < 0.3.0`（不算更新）
   - `1.0.0 > 0.9.9`（不按字典序，按数字）
   - `0.10.0 > 0.9.0`（两位数段）
   - 非法格式（`abc`、`1.2`、`1.2.3.4`）→ 按约定处理（抛错或视为无效）
2. **manifest 解析**：合法 JSON → 返回 `{version,url,notes}`；缺字段/非法 JSON → 返回错误。
3. **状态转移**（mock fetch）：拉到更高版本 → `available`；拉到低版本 → `upToDate`；fetch reject → `error`（manual）/ 保持 `idle`（非 manual）。
4. **去重**：连续两次 `checkForUpdates({manual:false})` 返回同一新版本，第二次应跳过置 `available`（读 `update-state.json` 标记）。

网络、IPC 广播、菜单接线这些集成层**不写自动化测试**（现有测试套也没测 IPC/菜单，遵循项目既有范围）。

### 手动验证清单（实现后照着跑）

- dev 下设 `TERMSTEP_UPDATE_URL` 指向本地返回更高版本的 JSON → 启动后 5 秒 sidebar 底部出现「有新版本」
- 点徽章 → popover 显示 notes，「去下载」在浏览器打开 url
- 改 manifest 版本 ≤ 当前 → 重启 → 徽章不出现
- 菜单「检查更新…」→ 手动触发，反馈正确（「已是最新版本」或 popover）
- 断网启动 → 无任何提示，无报错

## 改动文件清单

**新增：**
- `src/main/updater.ts` — 检查逻辑、状态机、纯函数 API
- `tests/updater.test.ts` — 纯函数测试
- `src/renderer/components/UpdateBadge.tsx` — 徽章 + popover 组件
- `src/renderer/hooks/useUpdateState.ts` — 状态订阅 hook

**改动：**
- `src/shared/types.ts` — `UPDATE_STATE` / `UPDATE_CHECK` 通道常量 + `UpdateState` 类型
- `src/preload/index.ts` — `api.update`
- `src/main/ipc.ts` — `UPDATE_CHECK` handler
- `src/main/index.ts` — 启动检查接线（whenReady 后延迟 5s）、广播接线
- `src/main/menu.ts` — 「检查更新…」菜单项
- `src/renderer/components/Sidebar.tsx` — 在 `.sidebar-io` 下方插入 `<UpdateBadge />`
- `src/renderer/main.tsx` / `global.d.ts` — `api.update` 类型声明
