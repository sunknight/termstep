import { describe, it, expect } from 'vitest';
import { parseButtonLine, renderButtonsBlock, parseButtonsFromMarkdown, escapeHtml, escapeAttr, parseButtonsJson } from '../src/shared/buttonBlock';

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

import { substituteParams } from '../src/shared/buttonBlock';

describe('substituteParams', () => {
  it('replaces a single placeholder', () => {
    expect(substituteParams('echo {{msg}}', { msg: 'hi' })).toBe('echo hi');
  });
  it('replaces multiple placeholders', () => {
    expect(substituteParams('{{a}} {{b}}', { a: '1', b: '2' })).toBe('1 2');
  });
  it('replaces every occurrence of the same name', () => {
    expect(substituteParams('{{a}}-{{a}}', { a: 'x' })).toBe('x-x');
  });
  it('empty value replaces with empty string', () => {
    expect(substituteParams('git push {{flags}}', { flags: '' })).toBe('git push');
  });
  it('undeclared placeholder left as-is', () => {
    expect(substituteParams('echo {{x}}', {})).toBe('echo {{x}}');
  });
  it('trims leading/trailing whitespace', () => {
    expect(substituteParams('   hi   ', {})).toBe('hi');
  });
});

describe('parseButtonsJson', () => {
  it('accepts a single object', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'echo hi' }));
    expect('buttons' in r).toBe(true);
    expect((r as { buttons: any[] }).buttons)
      .toEqual([{ command: 'echo hi', label: 'echo hi', edit: false }]);
  });
  it('accepts an array', () => {
    const r = parseButtonsJson(JSON.stringify([{ command: 'a' }, { command: 'b' }]));
    expect((r as { buttons: any[] }).buttons.map((b) => b.command)).toEqual(['a', 'b']);
  });
  it('drops entries without command', () => {
    const r = parseButtonsJson(JSON.stringify([{ command: 'a' }, { label: 'no cmd' }]));
    expect((r as { buttons: any[] }).buttons.length).toBe(1);
  });
  it('drops params without name', () => {
    const r = parseButtonsJson(JSON.stringify({
      command: 'x', params: [{ hint: 'h' }, { name: 'ok' }],
    }));
    expect((r as { buttons: any[] }).buttons[0].params).toEqual([{ name: 'ok' }]);
  });
  it('coerces strictly: only === true is truthy; options filtered to strings', () => {
    const r = parseButtonsJson(JSON.stringify({
      command: 'x',
      edit: 'true',
      params: [{ name: 'p', required: 1, options: ['a', 2, 'b'], default: 'd' }],
    }));
    const btn = (r as { buttons: any[] }).buttons[0];
    expect(btn.edit).toBe(false);
    expect(btn.params[0].required).toBeUndefined();
    expect(btn.params[0].options).toEqual(['a', 'b']);
    expect(btn.params[0].default).toBe('d');
  });
  it('returns error on malformed JSON', () => {
    const r = parseButtonsJson('{ not json');
    expect('error' in r).toBe(true);
  });
  it('label defaults to command when omitted', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'git status' }));
    expect((r as { buttons: any[] }).buttons[0].label).toBe('git status');
  });
  it('keeps explicit label', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'git status', label: '状态' }));
    expect((r as { buttons: any[] }).buttons[0].label).toBe('状态');
  });
  it('omits params key when params is empty', () => {
    const r = parseButtonsJson(JSON.stringify({ command: 'x', params: [] }));
    expect((r as { buttons: any[] }).buttons[0].params).toBeUndefined();
  });
});
