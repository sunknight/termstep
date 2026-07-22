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
// 省略 ANSI 16 色字段时，xterm 用内置 Tango 调色板。Tango 是**为深色背景**设计
// 的（blue=#3465a4 沉中蓝、yellow=#c4a000 暗橄榄、black=#2e3436 炭黑），在深色
// 主题下观感正合适，所以 xtermDark 不覆盖；但在浅色主题（白底）下同一套色会发暗
// 发灰——典型表现：tmux `status-bg blue` 压一整条深蓝、`fg=yellow` 灰扑扑，比
// Termius/iTerm2 等客户端里明显看不清。所以浅色主题必须换一套**为白底调过亮度/
// 饱和度**的调色板。下面的色值采样自一个用户认可的 SSH 客户端浅色截图（像素级
// 取色）：blue 是 Termius 风的鲜亮青蓝 #01a0e4（不是 Tango 的沉中蓝，也不是
// iTerm2 Light 的纯蓝 #0225c7），yellow/black 同步用采样真实值，其余用低饱和
// 柔和值不抢戏。背景近白 #f7f7f7——「浅蓝感」主要来自状态栏那条鲜亮青蓝。
const xtermLight: ITheme = {
  background: '#f7f7f7',
  foreground: '#383a42',
  cursor: '#01a0e4',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(90,193,237,0.22)',
  // ANSI 16 色：blue 采样自 Termius 风鲜亮青蓝，其余用低饱和柔和值。
  // blue 分层：普通 blue 调淡（#5ac1ed）给 tmux status-bg 等大面积背景用，
  // 不至于压一整条深蓝；brightBlue 鲜亮（#01a0e4 采样原值）给加粗/亮色蓝
  // 文字用（ls 目录等），保证白底上仍清晰可读。tmux 配 status-bg blue 命中
  // 普通 blue，status bar 因此变淡；加粗蓝文字命中 brightBlue，保持醒目。
  black: '#090300',
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#c1b656',
  blue: '#5ac1ed',
  magenta: '#d4649c',
  cyan: '#0598be',
  white: '#f7f7f7',
  brightBlack: '#5c5f77',
  brightRed: '#e0405a',
  brightGreen: '#56b32b',
  brightYellow: '#d8c860',
  brightBlue: '#01a0e4',
  brightMagenta: '#e88bc4',
  brightCyan: '#3bc4d8',
  brightWhite: '#ffffff',
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
