import MarkdownIt from 'markdown-it';
import {
  parseButtonsFenceInfo,
  renderButtonsBlock,
  renderButtonsJsonBlock,
} from '../../shared/buttonBlock';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// 通过 env.isRemote 标记当前渲染的帮助页是否来自远程订阅，让 buttons 渲染给
// 按钮加 data-remote 属性（CSS 视觉区分 + 点击时首次确认）。调用方在 md.render
// 时传入第二个参数 { isRemote: true }。fence info 经过 parseButtonsFenceInfo 解析，
// 支持 ` copy` 后缀（如 ```buttons copy）：命中的按钮只复制到剪贴板，不注入终端，
// 渲染时加 data-copy="1" 由下游点击处理器路由到复制逻辑。
//
// ```mermaid 围栏（info 首词，大小写不敏感）不直接内联 SVG——markdown-it 渲染是
// 同步纯字符串，而 mermaid 需要真实 DOM 测量。这里输出占位 wrapper：源码存
// data-src（供 lib/mermaid.ts 渲染与主题切换重渲染），内嵌 fallback pre 保证
// JS 未跑/渲染失败时源码仍可读。真正的 SVG 替换由 lib/mermaid.ts 在 DOM 插入后完成。
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  const { type, copyOnly } = parseButtonsFenceInfo(info);
  const isRemote = !!(env && env.isRemote);
  if (type === 'buttons') return renderButtonsBlock(token.content, { isRemote, copyOnly });
  if (type === 'buttons-json') return renderButtonsJsonBlock(token.content, { isRemote, copyOnly });
  if (info.split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
    const src = md.utils.escapeHtml(token.content);
    return `<div class="mermaid-wrap" data-src="${src}"><pre class="mermaid-fallback"><code>${src}</code></pre></div>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};
