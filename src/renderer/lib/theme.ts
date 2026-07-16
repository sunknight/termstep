import type { ITheme } from '@xterm/xterm';
import { termRegistry } from './termRegistry';

// 主题中枢。三个职责：
//   1. 在 React 渲染前同步初始化（initTheme）——避免首屏闪烁（FOUC）。
//      main.tsx 是 module 脚本，createRoot 之前调用 initTheme()，此时 body 为空，
//      设好 data-theme 后才渲染，首帧即正确主题。
//   2. 切换模式（applyTheme）——写 data-theme 驱动 CSS 变量，并把新的 xterm
//      主题热更新到所有已创建的终端（termRegistry.forEach）。
//   3. 供 TerminalView 在构造终端时读取当前主题（getXtermTheme）。
//   只支持浅 / 深两档，无「跟随系统」。

export type ThemeMode = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'termstep:theme';

// 首次启动或未配置时，默认使用浅色模式。
let currentMode: ThemeMode = 'light';
let currentResolved: ResolvedTheme = 'light';

// ---- xterm 主题（两套）-------------------------------------------------
// 只设置「界面色」（背景 / 前景 / 光标 / 选区），**不覆盖 ANSI 16 色调色板**。
// 程序（shell PS1、tmux 状态栏等）通过 ANSI 颜色转义码自行着色，若在这里改写
// black/red/.../brightWhite，会把它们定义的颜色全部替换掉——导致 tmux 和提示符
// 变成奇怪的蓝。省略这些字段，xterm 即用内置标准 VGA 16 色透传，程序原色保留。
const xtermLight: ITheme = {
  background: '#ffffff',
  foreground: '#18181b',
  cursor: '#3b82f6',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(59,130,246,0.18)',
};

const xtermDark: ITheme = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#60a5fa',
  cursorAccent: '#09090b',
  selectionBackground: 'rgba(96,165,250,0.26)',
};

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode;
}

/** 当前实际生效的主题（供 TerminalView 构造终端时读取）。 */
export function getXtermTheme(): ITheme {
  return currentResolved === 'dark' ? xtermDark : xtermLight;
}

function applyResolvedToDom(): void {
  document.documentElement.dataset.theme = currentResolved;
}

function applyResolvedToTerms(): void {
  const theme = getXtermTheme();
  termRegistry.forEach((t) => {
    t.options.theme = theme;
  });
}

function refresh(resolved: ResolvedTheme): void {
  if (resolved === currentResolved) return;
  currentResolved = resolved;
  applyResolvedToDom();
  applyResolvedToTerms();
}

/** 在 React 渲染前同步调用：读 localStorage + 设好 data-theme。 */
export function initTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  currentMode = saved === 'light' || saved === 'dark' ? saved : 'light';
  currentResolved = resolve(currentMode);
  applyResolvedToDom();
}

/** 切换主题模式（用户在设置里选）。同步生效，并持久化。 */
export function applyTheme(mode: ThemeMode): void {
  currentMode = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  refresh(resolve(mode));
}

/** 当前用户偏好模式（设置面板选中态用）。 */
export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}
