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
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  const { type, copyOnly } = parseButtonsFenceInfo(info);
  const isRemote = !!(env && env.isRemote);
  if (type === 'buttons') return renderButtonsBlock(token.content, { isRemote, copyOnly });
  if (type === 'buttons-json') return renderButtonsJsonBlock(token.content, { isRemote, copyOnly });
  return defaultFence(tokens, idx, options, env, self);
};
