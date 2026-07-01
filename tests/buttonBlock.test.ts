import { describe, it, expect } from 'vitest';
import { parseButtonLine, renderButtonsBlock, parseButtonsFromMarkdown, escapeHtml, escapeAttr } from '../src/shared/buttonBlock';

describe('parseButtonLine', () => {
  it('command only -> label is the command', () => {
    expect(parseButtonLine('git status')).toEqual({ command: 'git status', label: 'git status', edit: false });
  });

  it('command # label splits on " # "', () => {
    expect(parseButtonLine('git status # 查看状态')).toEqual({ command: 'git status', label: '查看状态', edit: false });
  });

  it('trailing " // edit" sets edit and is stripped', () => {
    expect(parseButtonLine('git commit -m "" // edit')).toEqual({ command: 'git commit -m ""', label: 'git commit -m ""', edit: true });
  });

  it('label + edit together', () => {
    expect(parseButtonLine('git push # 推送 // edit')).toEqual({ command: 'git push', label: '推送', edit: true });
  });

  it('pipes and quotes survive (no split)', () => {
    expect(parseButtonLine('ls | grep foo')).toEqual({ command: 'ls | grep foo', label: 'ls | grep foo', edit: false });
  });

  it('blank lines are null', () => {
    expect(parseButtonLine('   ')).toBeNull();
    expect(parseButtonLine('')).toBeNull();
  });
});

describe('renderButtonsBlock', () => {
  it('renders one button per non-blank line', () => {
    const html = renderButtonsBlock('git status\n\ngit push');
    expect(html).toContain('<div class="cmd-buttons">');
    expect(html.match(/<button/g)!.length).toBe(2);
  });

  it('puts command in data-cmd (attribute-escaped) and label in text', () => {
    const html = renderButtonsBlock('echo "hi" # say');
    expect(html).toContain('data-cmd="echo &quot;hi&quot;"');
    expect(html).toContain('>say<');
  });

  it('data-tip carries the command for labeled buttons (drives the custom tooltip)', () => {
    const html = renderButtonsBlock('git status # 查看状态');
    expect(html).toContain('data-tip="git status"');
    expect(html).toContain('>查看状态<');
    // command-only buttons (label === command) get no tooltip
    expect(renderButtonsBlock('git log')).not.toContain('data-tip');
  });

  it('data-edit is 1 or 0', () => {
    expect(renderButtonsBlock('a // edit')).toContain('data-edit="1"');
    expect(renderButtonsBlock('a')).toContain('data-edit="0"');
  });

  it('empty input -> empty string', () => {
    expect(renderButtonsBlock('')).toBe('');
    expect(renderButtonsBlock('\n\n')).toBe('');
  });
});

describe('escapers', () => {
  it('escapeHtml covers & < >', () => {
    expect(escapeHtml('a&b<c>')).toBe('a&amp;b&lt;c&gt;');
  });
  it('escapeAttr also covers quotes', () => {
    expect(escapeAttr('a"b')).toBe('a&quot;b');
  });
});

describe('parseButtonsFromMarkdown', () => {
  it('collects buttons across multiple fences in document order', () => {
    const md = [
      '# Title',
      '',
      '```buttons',
      'git status # 状态',
      'git pull',
      '```',
      '',
      'some text',
      '',
      '```buttons',
      'docker ps // edit',
      '```',
    ].join('\n');
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.map((b) => b.command)).toEqual(['git status', 'git pull', 'docker ps']);
    expect(btns[0].label).toBe('状态');
    expect(btns[2].edit).toBe(true);
  });

  it('ignores non-buttons fences', () => {
    const md = '```bash\ngit status\n```\n\n```buttons\nls\n```';
    expect(parseButtonsFromMarkdown(md).map((b) => b.command)).toEqual(['ls']);
  });

  it('returns empty for markdown with no buttons blocks', () => {
    expect(parseButtonsFromMarkdown('# nothing here')).toEqual([]);
    expect(parseButtonsFromMarkdown('')).toEqual([]);
  });
});
