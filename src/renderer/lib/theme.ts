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

let currentMode: ThemeMode = 'dark';
let currentResolved: ResolvedTheme = 'dark';

// ---- xterm 主题（两套）-------------------------------------------------
// 配色与 CSS 变量保持同一调性：浅色用白底深字，深色用近黑底浅字；光标用强调色。
const xtermLight: ITheme = {
  background: '#ffffff',
  foreground: '#18181b',
  cursor: '#3b82f6',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(59,130,246,0.18)',
  // ANSI 16 色：浅色主题用偏深的色相，保证在白底上可读。
  black: '#18181b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#c026d3',
  cyan: '#0891b2',
  white: '#71717a',
  brightBlack: '#52525b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#d946ef',
  brightCyan: '#06b6d4',
  brightWhite: '#3f3f46',
};

const xtermDark: ITheme = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#60a5fa',
  cursorAccent: '#09090b',
  selectionBackground: 'rgba(96,165,250,0.26)',
  // 深色主题用偏亮的色相，保证在近黑底上可读。
  black: '#09090b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#e879f9',
  cyan: '#22d3ee',
  white: '#a1a1aa',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#f0abfc',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
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
  currentMode = saved === 'light' || saved === 'dark' ? saved : 'dark';
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
