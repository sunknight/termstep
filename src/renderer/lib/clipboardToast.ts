import { api } from './api';

/**
 * 将命令复制到剪贴板并显示「已复制到剪贴板」toast。
 * copy-only 按钮与 ⌘/Ctrl 修饰键复制共用此核心逻辑。
 */
export async function copyCommand(command: string): Promise<void> {
  await api.clipboard.writeText(command);
  showToast('已复制到剪贴板');
}

// 如果按了 ⌘（macOS）/ Ctrl 修饰键，将命令复制到剪贴板并显示 toast，返回 true。
// 未按修饰键则返回 false，调用方继续走正常执行流程。
export async function copyOnModifier(
  e: { metaKey?: boolean; ctrlKey?: boolean },
  command: string
): Promise<boolean> {
  if (!e.metaKey && !e.ctrlKey) return false;
  await copyCommand(command);
  return true;
}

export function showToast(text: string): void {
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
