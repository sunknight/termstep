# ⌘+点击命令按钮复制到剪贴板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按住 ⌘/Ctrl 点击命令按钮时复制命令到剪贴板（而非输入终端），并显示轻量 toast 提示。

**Architecture:** 新建一个共享的 `clipboardToast.ts`，封装修饰键检测 + 复制 + toast 逻辑。HelpPane 和 QuickCommands 两处点击处理分别调用它。新增少量 CSS。纯前端改动，后端 `clipboard_write` 已就绪。

**Tech Stack:** React 18, TypeScript, Tauri v2 (`api.clipboard.writeText`), CSS。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/renderer/lib/clipboardToast.ts` | 新建 | `copyOnModifier()` 共享函数 + `showToast()` DOM toast |
| `src/renderer/styles.css` | 修改 | 新增 `.clipboard-toast` 样式 |
| `src/renderer/components/HelpPane.tsx` | 修改 | 点击处理中插入修饰键分支 |
| `src/renderer/components/QuickCommands.tsx` | 修改 | `run()` 接收事件 + 修饰键分支 |

---

### Task 1: 创建 `clipboardToast.ts` 共享模块

**Files:**
- Create: `src/renderer/lib/clipboardToast.ts`

- [ ] **Step 1: 创建文件**

```typescript
import { api } from './api';

// 如果按了 ⌘（macOS）/ Ctrl 修饰键，将命令复制到剪贴板并显示 toast，返回 true。
// 未按修饰键则返回 false，调用方继续走正常执行流程。
export async function copyOnModifier(
  e: { metaKey?: boolean; ctrlKey?: boolean },
  command: string
): Promise<boolean> {
  if (!e.metaKey && !e.ctrlKey) return false;
  await api.clipboard.writeText(command);
  showToast('已复制到剪贴板');
  return true;
}

function showToast(text: string): void {
  const el = document.createElement('div');
  el.className = 'clipboard-toast';
  el.textContent = text;
  document.body.appendChild(el);
  // 下一帧添加 .show 触发淡入动画。
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 1500);
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add src/renderer/lib/clipboardToast.ts
git commit -m "feat: 添加 copyOnModifier 共享复制逻辑与轻量 toast"
```

---

### Task 2: 添加 toast CSS 样式

**Files:**
- Modify: `src/renderer/styles.css`（在 `.cmd-tip` 规则后追加，约第 223 行）

- [ ] **Step 1: 在 `.cmd-tip { ... }` 块之后追加样式**

在 `styles.css` 第 223 行 `.cmd-tip` 闭合花括号 `}` 之后，插入：

```css
/* 轻量 toast：复制到剪贴板时的短暂提示，顶部居中淡入淡出。 */
.clipboard-toast {
  position: fixed; top: 16px; left: 50%; transform: translate(-50%, -10px);
  z-index: 200; padding: 6px 14px;
  background: #1e1e1e; color: #f4f4f6;
  font-size: 13px; border-radius: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  opacity: 0; transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
}
.clipboard-toast.show {
  opacity: 1; transform: translate(-50%, 0);
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/styles.css
git commit -m "feat: 添加 .clipboard-toast 样式"
```

---

### Task 3: HelpPane 点击处理添加修饰键分支

**Files:**
- Modify: `src/renderer/components/HelpPane.tsx:33-63`

- [ ] **Step 1: 在文件顶部添加 import**

在第 7 行 `import { api } from '../lib/api';` 之后添加：

```typescript
import { copyOnModifier } from '../lib/clipboardToast';
```

- [ ] **Step 2: 在 onClick 的 `if (btn)` 块中插入修饰键检查**

在第 37 行 `const command = btn.dataset['cmd'] ?? '';` 之后、第 38 行 `const edit = btn.dataset['edit'] === '1';` 之前插入 4 行。插入后该块开头变为：

```typescript
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        // ⌘/Ctrl + 点击：复制命令到剪贴板，不输入终端。
        if (e.metaKey || e.ctrlKey) {
          void copyOnModifier(e, command);
          return;
        }
        const edit = btn.dataset['edit'] === '1';
        // ……其余代码不变（paramsRaw、opts、prompt、runCommandChecked）
```

`copyOnModifier` 内部会再次判断修饰键并执行复制 + toast。由于此处已 `return`，后续的 `runCommandChecked` 不会执行。

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add src/renderer/components/HelpPane.tsx
git commit -m "feat: HelpPane 支持 ⌘/Ctrl+点击复制命令到剪贴板"
```

---

### Task 4: QuickCommands 添加修饰键分支

**Files:**
- Modify: `src/renderer/components/QuickCommands.tsx:49,110`

- [ ] **Step 1: 在文件顶部添加 import**

在第 6 行 `import { api } from '../lib/api';` 之后添加：

```typescript
import { copyOnModifier } from '../lib/clipboardToast';
```

- [ ] **Step 2: 修改 `run` 函数签名，添加事件参数和修饰键分支**

当前 `run` 函数（第 49-68 行）：

```typescript
  const run = (command: string, edit: boolean, params?: ButtonParam[]) => {
    const a = props.activeTool;
    if (!a) return;
```

改为：

```typescript
  const run = (command: string, edit: boolean, params: ButtonParam[], e?: React.MouseEvent) => {
    const a = props.activeTool;
    if (!a) return;
    // ⌘/Ctrl + 点击：复制命令到剪贴板，不输入终端。
    if (e && (e.metaKey || e.ctrlKey)) {
      void copyOnModifier(e, command);
      setOpen(false);
      return;
    }
```

- [ ] **Step 3: 修改按钮 onClick，传入事件对象**

当前代码（第 110 行）：

```tsx
                  onClick={() => run(b.command, b.edit, b.params)}
```

改为：

```tsx
                  onClick={(e) => run(b.command, b.edit, b.params, e)}
```

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add src/renderer/components/QuickCommands.tsx
git commit -m "feat: QuickCommands 支持 ⌘/Ctrl+点击复制命令到剪贴板"
```

---

### Task 5: 手动验证完整功能

**Files:** 无（运行时验证）

- [ ] **Step 1: 启动开发模式**

Run: `npm run dev`
Expected: Tauri 应用窗口启动

- [ ] **Step 2: 验证 HelpPane（右侧面板）的普通点击**

1. 点击右侧面板的任意命令按钮
2. 预期：命令输入到终端并执行（现有行为不变）

- [ ] **Step 3: 验证 HelpPane 的 ⌘+点击**

1. 按住 ⌘ 键，点击右侧面板的命令按钮
2. 预期：屏幕顶部出现「已复制到剪贴板」toast，约 1.5 秒后消失；终端无任何输入
3. 去 Finder 或其他应用粘贴（⌘V），确认剪贴板内容为命令文本

- [ ] **Step 4: 验证带参数按钮的 ⌘+点击**

1. 按住 ⌘ 键，点击一个带参数的命令按钮（含 `{{占位符}}`）
2. 预期：复制原始模板（含 `{{占位符}}`），不弹出参数表单

- [ ] **Step 5: 验证危险命令的 ⌘+点击**

1. 按住 ⌘ 键，点击一个危险命令（如 `rm -rf xxx`）
2. 预期：直接复制，不弹出危险命令确认对话框

- [ ] **Step 6: 验证 QuickCommands（快捷命令下拉）**

1. 点击顶部「⚡ 快捷命令」展开下拉
2. 普通点击一个命令：输入终端执行
3. ⌘+点击一个命令：复制到剪贴板，toast 出现，下拉关闭

- [ ] **Step 7: 验证 Ctrl+点击（跨平台兼容）**

1. 按住 Ctrl 键点击命令按钮
2. 预期：与 ⌘+点击行为一致（复制到剪贴板）
