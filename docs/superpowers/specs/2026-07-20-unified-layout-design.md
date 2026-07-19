# 统一布局系统：消除普通/文档模式，改为可切换布局 + 可隐藏终端

## 背景

TermStep 现有两种工具模式：**终端型**（`type:"terminal"`，默认）和**仅文档型**（`type:"document"`，2026-07-19 引入）。

- 终端型：三栏布局——侧栏 / 终端中栏 / 帮助右栏。
- 文档型：整个右侧合并为一个文档区，**不渲染**终端、不创建 pty；点按钮无动作（隐式静默吞掉 write）。

这套二元 fork 带来几个问题：

1. **概念割裂**：「文档型工具」其实只是「不想看终端的工具」，却被建模成完全不同的渲染路径。
2. **灵活性差**：文档型工具无法临时唤出终端执行一条命令；终端型工具也无法把终端藏起来专心看文档。
3. **代码分叉**：`App.tsx` 里 `isDocument` 一个 boolean 决定渲染整片 JSX，模式间逻辑无法复用；终端生命周期和模式强耦合（文档型 unmount 所有 xterm）。
4. **隐式门控**：文档型点按钮「无动作」是 pty 未创建 + 后端静默吞 write 的副作用，不是显式语义。

## 目标

**统一两种模式为一套布局系统**：所有工具都是「文档区 + 终端区」的组合，通过两个维度配置：

- **布局方向**（`layout`）：`LR`（文档在左、终端在右）或 `TB`（文档在上、终端在下）。
- **终端可见性**（`terminalHidden`）：初始是否隐藏终端；隐藏后文档撑满，但 pty 保持活着，可随时 toggle 显示。

文档区仍可折叠为 Peek（保持现状机制）。完全消除 `type` 字段和 `isDocument` fork。

## 核心决定

1. **`type` 字段彻底废弃并清除**（不留读兼容）：迁移后所有 tool.json 不再有 `type` 字段。
2. **新增两个 ToolMeta 字段**：`layout: "LR" | "TB"`（默认 `"LR"`）、`terminalHidden: boolean`（默认 `false`）。
3. **布局方向仅工具配置控制**（保存后生效，无运行时 toggle）。
4. **终端显隐 = 配置设默认 + 运行时顶栏 toggle**（临时状态不写回配置）。
5. **终端隐藏时 pty 保持活着**：用 xterm detach/reattach 保留输出历史（不 dispose、不重新 spawn）。
6. **终端隐藏时点命令按钮 → toast「请先打开终端」**；⌘/Ctrl+click 复制照常工作（不门控）。
7. **尺寸持久化全局共享、按布局方向分两个值**：`termstep:term-size-lr`（LR 终端宽度）、`termstep:term-size-tb`（TB 终端高度）。
8. **老 `type:"document"` 工具迁移**：`layout:"TB"` + `terminalHidden:true`，删除 `type`。迁移幂等（用标志文件）。
9. **不保留「纯文档工具」概念**：所有工具都是「文档 + 可选终端」，只是默认显隐不同。

---

## 数据模型

### ToolMeta 新增字段

`src/shared/types.ts`（`src-tauri/src/types.rs` 对偶同步）：

```ts
interface ToolMeta {
  // ...现有字段不变...
  layout: "LR" | "TB";        // 布局方向。LR=文档左/终端右，TB=文档上/终端下。默认 "LR"。
  terminalHidden: boolean;    // 终端初始是否隐藏（配置默认值）。默认 false。
}
```

- **移除 `type` 字段**：types.ts、types.rs、PtySpawnOpts 都删；后端 `pty.rs::ensure` 的 `tool_type == "document"` 早返回（line 128-130）也删。
- **默认值**：`layout` 缺省 `"LR"`、`terminalHidden` 缺省 `false`——对老 terminal 工具零行为变化。
- **序列化（保持 tool.json 整洁）**：
  - `toolJson.ts`：`layout` 加进 `PRUNE_WHEN_EMPTY_STRING`（默认值 `"LR"` 序列化为空串被 prune；非默认 `"TB"` 保留）。
  - `terminalHidden` 加进 `PRUNE_WHEN_FALSE`（若该集合不存在则新建，命名遵循现有风格）。
  - 后端 `pure.rs` 对偶同步 prune 规则。

### 迁移（`src-tauri/src/tool_io.rs` 新增 `migrate_layout_fields_blocking`）

遵循 §6.5 迁移链约定——启动时、在 scan/seed/pty 之前、同步执行、幂等、用标志文件：

- 遍历 `configs/tools/*/tool.json`：
  - 若 `type == "document"`：写 `layout = "TB"`、`terminalHidden = true`，**删除 `type` 字段**。
  - 若 `type == "terminal"` 或无 `type`：删除 `type` 字段（若存在），`layout`/`terminalHidden` 保持缺省（不写盘）。
- **幂等标志文件**：`configs/.migrated-layout`。仅在所有 tool.json 处理成功后写。
- 写回用「临时文件 + rename」保证原子。
- **抽前后端共享纯函数**：把「字段转换」抽成 `migrate_meta(meta) -> meta`（TS 侧 + Rust 对偶），便于单测/UI 预览，与 `mergeToolJson`/`pure.rs` 现有对偶风格一致。

---

## 布局渲染

### App.tsx 主结构（消除 `isDocument` fork）

主区永远渲染「文档区 + 终端区」两个面板，通过 flex-direction 切布局方向：

```
.app (display:flex, height:100%)
├── Sidebar
└── .main-area (flex:1, display:flex)
    ├── .main-header          (顶栏：cwd / 快速命令 / 重启 / 终端 toggle)
    └── .main-body (flex:1, display:flex, flex-direction 按 layout 切)
        ├── .doc-pane         (HelpPane 容器，含折叠按钮)
        ├── .splitter         (拖动条，方向跟随布局)
        └── .term-pane        (TerminalPane 容器)
```

- `layout === "LR"` → `.main-body { flex-direction: row }`，splitter 是 `col-resize`（左右拖），改终端宽度。
- `layout === "TB"` → `.main-body { flex-direction: column }`，splitter 是 `row-resize`（上下拖），改终端高度。

### 顶栏位置（跨布局一致）

顶栏（cwd / 快速命令 / 重启 / 终端 toggle）提到 `.main-area` 顶部，脱离终端区，LR/TB 都在主区顶部——跨布局一致，toggle 按钮位置稳定好找。

### 终端隐藏 / 文档折叠（两种独立运行时状态）

| 状态 | 来源 | 效果 |
|---|---|---|
| `termHidden`（运行时） | 顶栏 toggle；初值取自 `meta.terminalHidden` | 隐藏时：`.term-pane` DOM 卸载、splitter 不渲染、`.doc-pane` flex:1 撑满。**pty 保持活着**（xterm 实例 detach 保留在 termRegistry）。 |
| `docCollapsed`（运行时，原 `helpCollapsed`） | 文档区角落 PanelToggle | 折叠时：`.doc-pane` 变 Peek 浮动层（保持现状机制）、splitter 不渲染、`.term-pane` flex:1 撑满。 |
| 两者都隐藏 | 极端情况 | 文档 Peek 浮动 + 终端撑满。可接受，不特殊处理。 |

切换工具时：`termHidden` 重置为新工具的 `meta.terminalHidden`；`docCollapsed` 保持现状（全局 localStorage key `termstep:help-collapsed`，跨工具共享）。

### xterm 隐藏时的生命周期（detach/reattach）

这是整个改动最 tricky 的部分，要专门处理 §6.2/§8.3「xterm 在 `display:none` 容器不画提示符」老坑。

**方案：隐藏 = 卸载 DOM 但保留 xterm Terminal 实例**

- `TerminalView` 用 ref 持有 `Terminal` 对象。
- 原逻辑「`props.active` 为 true 才创建 xterm」改为「工具激活即创建 xterm 实例」。
- `termHidden` 控制 xterm 是否 attach 到 DOM：
  - 隐藏：`term.element.detach()`（从 DOM 移除），Terminal 实例和 pty 读线程都不停。
  - 显示：`term.element.attachTo(container)` + `requestAnimationFrame` + `fit()`。
- xterm 实例不 dispose，输出缓冲保留；pty 读线程持续写入（即使 detached，数据在内存缓冲里，reattach 后立即可见）。

**为什么不选其他方案**：
- CSS `display:none` + reset 重画：portable-pty 无简单办法重放输出，丢历史。不采用。
- 完全 dispose + 重新 spawn：丢历史、体验倒退。不采用。

> 实现时拆成独立小步、配手动验证脚本：先做最小用例（toggle 隐藏→显示→输出仍在）再合入主流程。

### 拖动条尺寸持久化

两个全局 localStorage key（决策 7）：

- `termstep:term-size-lr` —— LR 布局下终端宽度（px）。
- `termstep:term-size-tb` —— TB 布局下终端高度（px）。

拖动 handler 根据 `layout` 决定写哪个/读哪个。切换布局方向不串设。

范围/默认（实现时微调）：
- LR 宽度：280 ~ 窗口宽 * 0.7，默认 560。
- TB 高度：120 ~ 窗口高 * 0.7，默认 320。

现有 `termstep:help-width` / `termstep:help-collapsed` 由 `docCollapsed` + 新拖动条接管（Peek 模式下仍用 help-width 作为浮动宽度）。

---

## 按钮执行门控

取代现状「隐式静默吞掉 write」的隐式门控，加一层显式检查（决策 4、8）：

```
HelpPane.onClick / QuickCommands.onRun
  └─ ⌘/Ctrl+click? → 复制（不门控，照常）            [现状保留]
  └─ 普通点击
       └─ termHidden === true?
            ├─ 是 → showToast('请先打开终端')，return    [新增]
            └─ 否 → runCommandChecked → runCommand     [现状]
```

- `termHidden` 是 App 顶层 state，通过 props/context 下发到 `HelpPane`、`QuickCommands`、以及文档 Peek 内的按钮。
- **toast 机制**：复用现有 `clipboardToast.ts`（扩展为通用 toast 或抽出 `toast.ts`），加 `showToast(message)` 通用方法，不引入新依赖。

---

## 配置 UI（EditorPane.tsx）

替换现有「普通/文档」radio（line 56-58, 251-272）为两组控件：

- **布局方向**：radio `LR（左右）/ TB（上下）`，默认 LR。
- **终端初始状态**：checkbox `默认隐藏终端`，默认不勾。

保存时走 `mergeToolJson` 的 prune 规则（见上文数据模型）。后端 `pure.rs` 对偶同步。

---

## 测试策略

### 单测（vitest，shared 层）

- `toolJson.mergeToolJson`：`layout` 默认值 `"LR"` 被 prune、非默认 `"TB"` 保留；`terminalHidden` 默认 `false` 被 prune、`true` 保留。
- `migrate_meta` 纯函数：`type:"document"` → `layout:"TB"` + `terminalHidden:true` + 无 `type`；`type:"terminal"`/无 type → 无 `type`、其余缺省；幂等（已迁移再跑不变）。

### Rust 测试（cargo test）

- `migrate_layout_fields_blocking`：构造 `type:"document"` tool.json → 迁移后字段正确；幂等（标志文件存在则跳过）；写回用临时文件+rename。
- `pure.rs`：序列化/解析对偶覆盖 `layout`/`terminalHidden`。

### 手动验证清单（实现时逐条过）

- [ ] 老 `type:"document"` 工具迁移后：TB 布局、终端隐藏、文档撑满；toggle 显示终端后能正常执行命令、看到输出。
- [ ] LR 布局拖动条改宽度，切到 TB 布局（改配置保存），宽度值不串到高度；切回 LR 宽度仍在。
- [ ] 终端隐藏时点按钮 → toast「请先打开终端」；⌘/Ctrl+click 复制照常。
- [ ] toggle 隐藏→显示→再隐藏：输出历史保留（detach/reattach 验证）。
- [ ] 文档折叠为 Peek：终端撑满；Peek 中点按钮按主终端 `termHidden` 状态门控。
- [ ] 普通 terminal 工具（无新字段）：行为零变化（LR 布局、终端可见）。
- [ ] `npm run typecheck` + `npm run test` + `cargo test --manifest-path src-tauri/Cargo.toml` 全绿。

---

## 涉及文件

**渲染端（TS）**：
- `src/shared/types.ts` —— ToolMeta 加 `layout`/`terminalHidden`，删 `type`；PtySpawnOpts 删 `type`。
- `src/shared/toolJson.ts` —— prune 规则加 `layout`/`terminalHidden`；新增/复用 `migrate_meta` 纯函数。
- `src/renderer/App.tsx` —— 重构主区布局（消除 `isDocument` fork）、顶栏上提、新增 `termHidden` state、拖动条改双方向。
- `src/renderer/components/TerminalPane.tsx` / `TerminalView.tsx` —— xterm detach/reattach 生命周期。
- `src/renderer/components/HelpPane.tsx` —— 按钮 onClick 加 `termHidden` 门控。
- `src/renderer/components/QuickCommands.tsx` —— 同上门控。
- `src/renderer/components/EditorPane.tsx` —— 替换模式 radio 为布局方向 + 终端初始状态两组控件。
- `src/renderer/lib/termRegistry.ts` —— `runCommand` 不再依赖隐式无 pty 吞掉（显式门控前置）。
- `src/renderer/lib/toast.ts`（新或扩展 `clipboardToast.ts`）—— 通用 `showToast`。

**后端（Rust）**：
- `src-tauri/src/types.rs` —— ToolMeta 加 `layout`/`terminalHidden`，删 `tool_type`；PtySpawnOpts 删 `type`。
- `src-tauri/src/pure.rs` —— prune 对偶；`migrate_meta` 对偶纯函数。
- `src-tauri/src/pty.rs` —— 删 `ensure` 的 `tool_type == "document"` 早返回（line 128-130）。
- `src-tauri/src/tool_io.rs` —— 新增 `migrate_layout_fields_blocking`，接入迁移链。
- `src-tauri/src/lib.rs` —— setup() 里调用新迁移（在现有迁移之后、scan/seed/pty 之前）。

**样式**：
- `src/renderer/styles.css` —— `.main-area` / `.main-body` / `.term-pane` / `.doc-pane` / 双方向 splitter 样式；调整 `.help-area.document-mode` 相关（废弃）。

**测试**：
- `tests/`（vitest）—— `toolJson` prune + `migrate_meta` 纯函数。
- Rust 测试 —— 迁移 + pure 序列化对偶。

---

## 非目标 / 不做的事

- **不引入运行时布局方向 toggle**（决策 5）：布局方向仅配置控制，避免误触和 DOM 重排的复杂度。
- **不做每个工具独立的尺寸记忆**（决策 7）：全局共享两个值已足够。
- **不保留「纯文档工具」类型概念**（决策 9）：统一为「文档 + 可选终端」。
- **不引入新 toast 依赖**：复用现有浮层机制。
- **不改后端 pty 池模型**：除了删 document 早返回，pty 生命周期逻辑不变。
- **不改按钮解析/markdown 渲染**：`buttons`/`buttons-json` 围栏、Peek、PreviewOverlay 等全部复用现状。
