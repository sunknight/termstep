import MarkdownIt from 'markdown-it';
import { renderButtonsBlock } from '../../shared/buttonBlock';

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === 'buttons') {
    return renderButtonsBlock(token.content);
  }
  return defaultFence(tokens, idx, options, env, self);
};
