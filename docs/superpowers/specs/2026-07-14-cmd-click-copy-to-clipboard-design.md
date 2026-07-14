# ⌘+点击命令按钮复制到剪贴板

## 目标

按住 ⌘（macOS）/ Ctrl 键点击命令按钮时，将命令复制到剪贴板，而非输入到终端。普通点击行为不变。

## 行为规则

| 场景 | 普通点击 | ⌘/Ctrl + 点击 |
|------|---------|---------------|
| 普通命令 | 输入终端并执行 | 复制到剪贴板 |
| 危险命令 | 弹确认对话框 | 直接复制（跳过确认） |
| 带参数按钮 | 弹参数表单 → 执行 | 复制原始模板（含 `{{占位符}}`） |
| 编辑模式按钮 | 粘贴到终端（不按回车） | 复制 `data-cmd` 原文 |

复制成功后显示轻量 toast「已复制到剪贴板」，约 1.5 秒后自动消失。

## 改动范围

纯前端改动，**无需 Rust/IPC 变更**（`api.clipboard.writeText` 及后端 `clipboard_write` 命令已存在）。

### 新建文件

#### `src/renderer/lib/clipboardToast.ts`

共享复制逻辑 + 轻量 toast，供 HelpPane 和 QuickCommands 调用。

```typescript
import { api } from './api';

// 如果按了 ⌘/Ctrl 修饰键，将命令复制到剪贴板并显示 toast，返回 true。
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

### 修改文件

#### `src/renderer/components/HelpPane.tsx`

在 `onClick` 的 `if (btn)` 块（约第 36 行）顶部，读取 `command` 后插入修饰键检查：

```typescript
const command = btn.dataset['cmd'] ?? '';
if (await copyOnModifier(e, command)) return;   // ← 新增
```

因为 `onClick` 是 `MouseEvent` 处理器（非 async），需将修饰键分支提取到处理器顶部，在同步获取 `command` 后调用 `void copyOnModifier(e, command).then(...)` 或直接内联。实际实现：将修饰键检查放在 `const command = ...` 之后、参数化分支之前，用 `void` 调用并 `return`。

#### `src/renderer/components/QuickCommands.tsx`

1. `run` 函数签名增加事件参数：`run(command, edit, params?, e?)`
2. 按钮的 `onClick` 改为 `onClick={(e) => run(b.command, b.edit, b.params, e)}`
3. `run` 内部首先检查修饰键：

```typescript
const run = (command, edit, params?, e?: React.MouseEvent) => {
  if (e && (e.metaKey || e.ctrlKey)) {
    void api.clipboard.writeText(command).then(() => showToast('已复制到剪贴板'));
    setOpen(false);
    return;
  }
  // ...现有逻辑不变
};
```

#### `src/renderer/styles.css`

新增 `.clipboard-toast` 样式（约 15 行），参考现有 `.cmd-tip` 风格：

```css
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

## 不触碰的部分

- `src-tauri/src/commands.rs` — `clipboard_write` 已存在
- `src/renderer/lib/api.ts` — `api.clipboard.writeText` 已就绪
- `src/renderer/lib/runCommandChecked.ts` — 复制路径绕过它
- `src/shared/buttonBlock.ts` — 按钮渲染逻辑不变

## 数据流

```
⌘+点击按钮
  ├─ HelpPane.onClick(e) / QuickCommands.run(..., e)
  ├─ 检测到 metaKey/ctrlKey
  │   ├─ api.clipboard.writeText(command) → clipboard_write → arboard
  │   └─ showToast() → 临时 DOM 元素，1.5s 后淡出移除
  └─ return（不调用 runCommandChecked）
```
