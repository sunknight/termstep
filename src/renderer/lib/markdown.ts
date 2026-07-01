import MarkdownIt from 'markdown-it';
import { renderButtonsBlock, renderButtonsJsonBlock } from '../../shared/buttonBlock';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  if (info === 'buttons') return renderButtonsBlock(token.content);
  if (info === 'buttons-json') return renderButtonsJsonBlock(token.content);
  return defaultFence(tokens, idx, options, env, self);
};
