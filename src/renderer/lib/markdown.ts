import MarkdownIt from 'markdown-it';
import { renderButtonsBlock, renderButtonsJsonBlock } from '../../shared/buttonBlock';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// 通过 env.isRemote 标记当前渲染的帮助页是否来自远程订阅，让 buttons 渲染给
// 按钮加 data-remote 属性（CSS 视觉区分 + 点击时首次确认）。调用方在 md.render
// 时传入第二个参数 { isRemote: true }。
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  const isRemote = !!(env && env.isRemote);
  if (info === 'buttons') return renderButtonsBlock(token.content, { isRemote });
  if (info === 'buttons-json') return renderButtonsJsonBlock(token.content, { isRemote });
  return defaultFence(tokens, idx, options, env, self);
};
