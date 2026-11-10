import { getResolvedTheme } from './theme';

// 帮助页 mermaid 图渲染器。markdown.ts 的 fence 覆盖把 ```mermaid 围栏输出为
// 占位 wrapper（.mermaid-wrap：源码存 data-src，内嵌 fallback pre），本模块在
// DOM 插入后把占位替换为 mermaid 渲染出的 SVG。要点：
//  - 懒加载：首个含图文档才动态 import('mermaid')（独立 chunk，体量大，不拖累首屏）。
//  - 串行队列：mermaid 只保证 render 之间串行，initialize 与在飞 render 并发会竞态，
//    所以整个流程（initialize + 全部块渲染）进同一条队列。
//  - 主题感知：light→default / dark→dark；主题变化由调用方用 force 重新调用，
//    从 data-src 重渲染全部块（顺带重试此前失败的块）。
//  - display:none 安全：目标在关闭的 <details> 里也没关系——mermaid 在 body 里的
//    隐藏临时容器中测量，返回 SVG 字符串后我们自行注入。
//  - 错误降级：单块解析失败只标记该块（mermaid-error + 错误提示条），保留源码
//    pre 可读，不影响同页其他块。securityLevel 保持 strict（远程内容不可信，
//    mermaid 内置 DOMPurify 消毒）。

type MermaidApi = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme = '';
let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

function mermaidTheme(): 'default' | 'dark' {
  return getResolvedTheme() === 'dark' ? 'dark' : 'default';
}

async function ensureMermaid(theme: 'default' | 'dark'): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  const m = await mermaidPromise;
  // 主题与上次初始化不同才重新 initialize（初始化全局生效，避免多余开销）。
  if (initializedTheme !== theme) {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // 解析失败不画 mermaid 默认的「炸弹」错误图（我们用自己的降级样式），
      // 且错误路径会自动清理 body 里的临时测量元素（v12 行为）。
      suppressErrorRendering: true,
      theme,
    });
    initializedTheme = theme;
  }
  return m;
}

// 把 fn 排进全局串行队列：无论前一个成败都接着跑，返回 fn 的结果。
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function renderBlock(m: MermaidApi, wrap: HTMLElement): Promise<void> {
  const src = wrap.dataset['src'] ?? '';
  try {
    const { svg } = await m.render(`termstep-mmd-${seq++}`, src);
    wrap.innerHTML = svg;
    wrap.classList.add('mermaid-done');
    wrap.classList.remove('mermaid-error');
  } catch (err) {
    // 失败降级：保留 fallback pre（源码可读），标红并前置错误提示条（防重复插入）。
    wrap.classList.add('mermaid-error');
    wrap.classList.remove('mermaid-done');
    if (!wrap.querySelector('.mermaid-error-note')) {
      const note = document.createElement('div');
      note.className = 'mermaid-error-note';
      note.textContent = `流程图解析失败：${err instanceof Error ? err.message : String(err)}`;
      wrap.prepend(note);
    }
  }
}

/**
 * 渲染 root 内所有 mermaid 占位块。
 * @param force true 时连已渲染的块也从 data-src 重渲染（主题切换配色跟随用）；
 *              默认只渲染未成功的块（失败的块自然重试）。
 */
export function renderMermaidIn(root: HTMLElement, opts?: { force?: boolean }): Promise<void> {
  const force = !!opts?.force;
  return enqueue(async () => {
    const wraps = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-wrap'));
    // 队列执行时 DOM 可能已被 React 替换（html 快速变化），过滤仍在文档中的块，
    // 脱离文档的写入无害但白费——跳过即可。
    const targets = wraps.filter(
      (w) => root.contains(w) && (force || !w.classList.contains('mermaid-done')),
    );
    if (targets.length === 0) return;
    const m = await ensureMermaid(mermaidTheme());
    for (const wrap of targets) {
      if (!root.contains(wrap)) continue; // 渲染期间内容又被替换
      await renderBlock(m, wrap);
    }
  });
}
