import { describe, it, expect } from 'vitest';
import { classifyLink, resolveDocPath, hasDocExtension, isTxtPath } from '../src/shared/previewLink';

describe('classifyLink — scheme 路由', () => {
  it('mailto → mailto（系统邮件）', () => {
    expect(classifyLink('mailto:foo@bar.com', '/cwd')).toEqual({ kind: 'mailto' });
  });

  it('http(s) 网页 → web', () => {
    expect(classifyLink('https://react.dev', '/cwd')).toEqual({ kind: 'web', url: 'https://react.dev' });
    expect(classifyLink('http://localhost:3000', '/cwd')).toEqual({ kind: 'web', url: 'http://localhost:3000' });
  });

  it('http(s) .md/.markdown/.txt → remoteDoc', () => {
    expect(classifyLink('https://a.com/guide.md', '/cwd')).toEqual({ kind: 'remoteDoc', url: 'https://a.com/guide.md' });
    expect(classifyLink('https://a.com/guide.MARKDOWN', '/cwd')).toEqual({ kind: 'remoteDoc', url: 'https://a.com/guide.MARKDOWN' });
    expect(classifyLink('https://a.com/notes.txt', '/cwd')).toEqual({ kind: 'remoteDoc', url: 'https://a.com/notes.txt' });
  });

  it('http(s) 文档后缀 + #anchor / ?query 仍判为文档', () => {
    expect(classifyLink('https://a.com/guide.md#sec', '/cwd').kind).toBe('remoteDoc');
    expect(classifyLink('https://a.com/guide.md?v=2', '/cwd').kind).toBe('remoteDoc');
  });

  it('非 http/mailto 的 scheme → blocked', () => {
    expect(classifyLink('javascript:alert(1)', '/cwd')).toEqual({ kind: 'blocked' });
    expect(classifyLink('data:text/html,<x>', '/cwd')).toEqual({ kind: 'blocked' });
    expect(classifyLink('tel:+123', '/cwd')).toEqual({ kind: 'blocked' });
  });
});

describe('classifyLink — 本地路径', () => {
  it('本地文档后缀 → localDoc（相对 cwd 解析）', () => {
    const c = classifyLink('./README.md', '/Users/x/proj');
    expect(c).toEqual({ kind: 'localDoc', path: '/Users/x/proj/README.md' });
  });

  it('本地绝对路径原样', () => {
    const c = classifyLink('/abs/path/doc.md', '/cwd');
    expect(c).toEqual({ kind: 'localDoc', path: '/abs/path/doc.md' });
  });

  it('本地非文档后缀 → unsupported', () => {
    expect(classifyLink('./script.sh', '/cwd')).toEqual({ kind: 'unsupported' });
    expect(classifyLink('./image.png', '/cwd')).toEqual({ kind: 'unsupported' });
  });

  it('file:// 文档 → localDoc（原样传递，后端 strip 前缀）', () => {
    const c = classifyLink('file:///abs/doc.md', '/cwd');
    expect(c).toEqual({ kind: 'localDoc', path: 'file:///abs/doc.md' });
  });
});

describe('resolveDocPath — 相对 cwd 解析', () => {
  it('绝对路径原样', () => {
    expect(resolveDocPath('/a/b.md', '/cwd')).toBe('/a/b.md');
  });

  it('home 简写原样', () => {
    expect(resolveDocPath('~/x.md', '/cwd')).toBe('~/x.md');
  });

  it('相对路径基于 cwd 拼接', () => {
    expect(resolveDocPath('README.md', '/Users/x/proj')).toBe('/Users/x/proj/README.md');
    expect(resolveDocPath('./docs/g.md', '/Users/x/proj')).toBe('/Users/x/proj/docs/g.md');
    expect(resolveDocPath('a/b/c.md', '/p')).toBe('/p/a/b/c.md');
  });

  it('规整 cwd 尾部多余分隔符', () => {
    expect(resolveDocPath('x.md', '/p/')).toBe('/p/x.md');
    expect(resolveDocPath('x.md', '/p///')).toBe('/p/x.md');
  });

  it('无 cwd 且相对路径 → 原样返回', () => {
    expect(resolveDocPath('x.md', undefined)).toBe('x.md');
  });

  it('保留 ../ 让后端自然解析（不强制规整）', () => {
    expect(resolveDocPath('../parent.md', '/p/sub')).toBe('/p/sub/../parent.md');
  });
});

describe('hasDocExtension / isTxtPath', () => {
  it('hasDocExtension 大小写不敏感', () => {
    expect(hasDocExtension('a.MD')).toBe(true);
    expect(hasDocExtension('a.Txt')).toBe(true);
    expect(hasDocExtension('a.markdown')).toBe(true);
    expect(hasDocExtension('a.html')).toBe(false);
    expect(hasDocExtension('a.md.txt')).toBe(true); // 以 .txt 结尾
  });

  it('忽略尾部 #anchor/?query', () => {
    expect(hasDocExtension('a.md#x')).toBe(true);
    expect(hasDocExtension('a.md?v=1')).toBe(true);
  });

  it('isTxtPath 仅 .txt', () => {
    expect(isTxtPath('a.txt')).toBe(true);
    expect(isTxtPath('a.md')).toBe(false);
    expect(isTxtPath('a.TXT')).toBe(true);
  });
});

describe('classifyLink — 边界', () => {
  it('空 href → blocked', () => {
    expect(classifyLink('', '/cwd')).toEqual({ kind: 'blocked' });
  });

  it('URL 大写 scheme 仍识别为 http', () => {
    expect(classifyLink('HTTPS://a.com/guide.md', '/cwd').kind).toBe('remoteDoc');
  });
});
