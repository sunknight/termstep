# 工具编辑界面改为 Modal 弹窗 - 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把右侧窄边栏里的「编辑工具」表单迁移到一个独立、宽敞的 Modal 弹窗中，提升编辑体验，同时不改变任何表单功能或数据逻辑。

**Architecture:** 新增 `EditorModal` 组件提供弹窗外壳；改造 `EditorPane` 为纯表单内容组件（去掉旧标题和独立滚动）；`App.tsx` 改为在编辑时始终渲染 `HelpPane`、再在最外层渲染 `EditorModal`。CSS 增加弹窗变体与双列表单布局。

**Tech Stack:** React 18 + TypeScript, Tauri v2, Vite, Vitest（本变更以类型检查和既有测试回归为主，无新增业务逻辑测试）。

---

## 文件变更清单

| 文件 | 变更类型 | 职责 |
|---|---|---|
| `src/renderer/components/EditorModal.tsx` | 新建 | 弹窗外壳：遮罩、标题栏、关闭、快捷键 |
| `src/renderer/components/EditorPane.tsx` | 修改 | 纯表单内容：字段、本地/远程 Tab、保存/取消按钮 |
| `src/renderer/App.tsx` | 修改 | 编辑时渲染 `EditorModal`，右侧始终显示 `HelpPane` |
| `src/renderer/styles.css` | 修改 | 弹窗尺寸、表单双列、Modal 内 EditorPane 样式覆盖 |

---

### Task 1: 创建 `EditorModal` 弹窗外壳

**Files:**
- Create: `src/renderer/components/EditorModal.tsx`

- [ ] **Step 1: 新建 `EditorModal.tsx`**

```tsx
import { useEffect } from 'react';
import type { Tool } from '../../shared/types';
import { EditorPane } from './EditorPane';

export function EditorModal(props: {
  tool: Tool;
  onDone: () => void;
  existingGroups: string[];
}) {
  // 关闭弹窗时恢复 body 滚动（保险）
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Esc 关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onDone]);

  return (
    <div className="modal-overlay" onClick={props.onDone}>
      <div
        className="modal editor-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-modal-title"
      >
        <div className="modal-header">
          <span id="editor-modal-title">编辑工具：{props.tool.meta.name}</span>
          <button
            className="modal-close"
            onClick={props.onDone}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <EditorPane
            tool={props.tool}
            onDone={props.onDone}
            existingGroups={props.existingGroups}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/EditorModal.tsx
git commit -m "feat(editor): add EditorModal shell"
```

---

### Task 2: 改造 `EditorPane` 为纯表单内容

**Files:**
- Modify: `src/renderer/components/EditorPane.tsx`

变更要点：
1. 删除最上方的 `.editor-header`（标题移到 `EditorModal`）。
2. 保留所有字段 state、本地/远程 Tab、保存逻辑、错误提示。
3. 在 `EditorPane` 内部增加 `Cmd/Ctrl + Enter` 快捷键保存。
4. 保存成功时调用 `props.onDone()` 关闭弹窗。

- [ ] **Step 1: 删除标题，添加键盘快捷键**

将文件开头 `import { useEffect, useRef, useState } from 'react';` 保持不变。

在 `EditorPane` 函数返回 JSX 之前、`save` 函数定义之后加入：

```tsx
// Cmd/Ctrl + Enter 快速保存（用 ref 避免闭包捕获旧 state）
const saveRef = useRef(save);
saveRef.current = save;

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void saveRef.current();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, []);
```

> 说明：通过 ref 指向最新的 `save`，避免在依赖数组里枚举所有 state 变量。

- [ ] **Step 2: 修改 `save()` 使其成功后关闭弹窗**

找到 `save` 函数中的 `await api.tool.save(...)` 成功分支，在 `props.onDone()` 之前保持现状；当前实现已在成功时调用 `props.onDone()`，无需额外改动。

- [ ] **Step 3: 移除 JSX 中的 `.editor-header`**

把返回的 JSX 从：

```tsx
return (
  <div className="editor">
    <div className="editor-header">编辑工具</div>
    ...
```

改为：

```tsx
return (
  <div className="editor">
    ...
```

（仅删除 `<div className="editor-header">编辑工具</div>` 这一行。）

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/EditorPane.tsx
git commit -m "refactor(editor): remove chrome from EditorPane for modal reuse"
```

---

### Task 3: `App.tsx` 使用 `EditorModal` 并始终显示帮助面板

**Files:**
- Modify: `src/renderer/App.tsx`

变更要点：
1. 导入 `EditorModal`。
2. 右侧帮助区条件渲染改为：只要 `active` 存在就渲染 `HelpPane`，不再用 `EditorPane` 替换。
3. 在顶层 `return` 中，`{!helpCollapsed && renderHelp(false)}` 之后，添加 `editingId && active && <EditorModal ... />`。

- [ ] **Step 1: 导入 `EditorModal`**

在 `App.tsx` 中，将：

```tsx
import { EditorPane } from './components/EditorPane';
```

替换为：

```tsx
import { EditorModal } from './components/EditorModal';
```

- [ ] **Step 2: 修改 `renderHelp` 函数**

将 `renderHelp` 中：

```tsx
{active && editingId === active.meta.id ? (
  <EditorPane
    tool={active}
    onDone={() => setEditingId(null)}
    existingGroups={existingGroups}
  />
) : active ? (
```

替换为：

```tsx
{active ? (
```

并删除与之对应的 `) : (` 分支和末尾多余的大括号。最终 `renderHelp` 内始终渲染 `HelpPane`（或 placeholder）。

简化后 `renderHelp` 大致如下（仅展示关键部分）：

```tsx
const renderHelp = (floating: boolean) => (
  <div className="help-area" style={{ ... }}>
    {active ? (
      <>
        {!floating && (
          <div className="help-toolbar">
            ...
          </div>
        )}
        <HelpPane ... />
      </>
    ) : (
      <div className="placeholder">无选中工具</div>
    )}
    {!floating && <div className="help-resizer" ... />}
  </div>
);
```

- [ ] **Step 3: 在顶层渲染 `EditorModal`**

在 `return (...)` 中，找到 `{!helpCollapsed && renderHelp(false)}` 行，在其后添加：

```tsx
{editingId && active && (
  <EditorModal
    tool={active}
    onDone={() => setEditingId(null)}
    existingGroups={existingGroups}
  />
)}
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/renderer/App.tsx
git commit -m "feat(editor): render EditorModal instead of in-pane EditorPane"
```

---

### Task 4: CSS 样式调整

**Files:**
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: 新增 `.editor-modal` 与相关样式**

在 `/* 模态层 */` 附近或文件末尾新增：

```css
/* Editor modal: wider than default modal for comfortable editing. */
.editor-modal {
  width: 720px;
  max-width: 90vw;
  max-height: 90vh;
}
.editor-modal .modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0;
}
.editor-modal .modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.editor-modal .modal-header #editor-modal-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modal-close {
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.modal-close:hover {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--border-strong);
}
```

- [ ] **Step 2: 调整 `.editor` 在弹窗内的表现**

更新 `.editor` 相关样式，确保它在 Modal body 内不额外产生滚动条：

```css
.editor-modal .editor {
  flex: 0 0 auto;
  min-height: 0;
  overflow-y: visible;
}
.editor-modal .editor-actions {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 4px;
}
```

- [ ] **Step 3: 添加双列表单布局**

在 `.meta-form` 相关样式附近新增：

```css
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.form-row .field {
  min-width: 0;
}
```

- [ ] **Step 4: 将表单字段改为双列排布**

修改 `EditorPane.tsx` 中 JSX 的「基本」和「终端」字段分组，把相关字段包进 `.form-row`：

在「基本」fieldset 内：

```tsx
<fieldset className="form-section">
  <legend>基本</legend>
  <div className="form-row">
    <label className="field">...名称...</label>
    <div className="field">...图标...</div>
  </div>
  <label className="field">...分组...</label>
</fieldset>
```

在「终端」fieldset 内：

```tsx
<fieldset className="form-section">
  <legend>终端</legend>
  <div className="form-row">
    <label className="field">...cwd...</label>
    <label className="field">...工具根目录...</label>
  </div>
  <div className="form-row">
    <label className="field">...tmux...</label>
    <label className="field">...自动更新...</label>
  </div>
  <label className="field">...启动命令...</label>
</fieldset>
```

> 注意：自动更新间隔字段当前在远程 Tab 内；若要把它也提到「终端」fieldset，需要一并移动其 state 与渲染。更保守的做法是：只把 `cwd` 和 `rootDir`、`tmux` 放双列，自动更新仍留在远程 Tab 内。本计划采用保守做法，不动自动更新的位置。

因此「终端」实际只排两列：

```tsx
<fieldset className="form-section">
  <legend>终端</legend>
  <div className="form-row">
    <label className="field">...cwd...</label>
    <label className="field">...工具根目录...</label>
  </div>
  <label className="field">...tmux...</label>
  <label className="field">...启动命令...</label>
</fieldset>
```

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/renderer/styles.css src/renderer/components/EditorPane.tsx
git commit -m "ui(editor): modal sizing and two-column form layout"
```

---

### Task 5: 验证与回归

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: 前端单测**

Run: `npm run test`
Expected: ALL PASS

- [ ] **Step 3: Rust 后端测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: ALL PASS

- [ ] **Step 4: 手动走查清单**

1. 启动 `npm run dev`。
2. 选中任意工具 → 点右侧「编辑」→ 应弹出 Modal，背后仍是终端和文档。
3. 检查 Modal 宽度、字段双列、本地/远程 Tab 是否正常。
4. 修改名称并保存 → Modal 关闭，侧栏工具名更新。
5. 按 `Esc` → Modal 关闭（不保存）。
6. 在表单内按 `Cmd+Enter`（或 `Ctrl+Enter`）→ 应触发保存并关闭。
7. 点遮罩层 → Modal 关闭（不保存）。
8. 新建工具 → 自动进入编辑 Modal。

- [ ] **Step 5: 提交（如需要）**

```bash
git add -A
git commit -m "feat(ui): tool editor in modal (0.9.x)"
```

---

## 自评检查

- **Spec coverage:** 设计文档中的 Modal 容器、触发关闭、布局、与三栏关系、不变范围、验收标准均已在任务中覆盖。
- **Placeholder scan:** 无 TBD/TODO；所有代码块为完整片段；测试命令明确。
- **Type consistency:** `EditorModal` 接收的 `tool`/`onDone`/`existingGroups` 类型与 `EditorPane` 及 `App.tsx` 一致。

---

## 执行方式

计划保存到 `docs/superpowers/plans/2026-07-19-editor-modal.md`。

建议采用 **Subagent-Driven Development** 按任务逐步执行，每个任务完成后检查类型并提交。
