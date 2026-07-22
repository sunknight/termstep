import { describe, it, expect } from 'vitest';
import { parseButtonLine, renderButtonsBlock, parseButtonsFromMarkdown, escapeHtml, escapeAttr, parseButtonsJson, renderButtonsJsonBlock, buildMdAppend, substituteCwd, parseButtonsFenceInfo } from '../src/shared/buttonBlock';

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

  it('"//" prefix line is null (text, not a button)', () => {
    expect(parseButtonLine('// note')).toBeNull();
    expect(parseButtonLine('//note')).toBeNull();
    expect(parseButtonLine('   // indented')).toBeNull();
  });

  it('"//" prefix wins over trailing " // edit" (text is not a button)', () => {
    expect(parseButtonLine('// note // edit')).toBeNull();
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

  it('"//" lines render as non-clickable text interleaved with buttons', () => {
    const html = renderButtonsBlock('// 检查\ngit status\n// 提交\ngit push # 推送');
    expect(html).toContain('<div class="cmd-text">检查</div>');
    expect(html).toContain('<div class="cmd-text">提交</div>');
    expect(html.match(/<button/g)!.length).toBe(2);
    // text rows carry no command data
    const textRow = html.match(/<div class="cmd-text">检查<\/div>/)![0];
    expect(textRow).not.toContain('data-cmd');
  });

  it('escapes text line content', () => {
    expect(renderButtonsBlock('// a < b & c')).toContain('a &lt; b &amp; c');
  });

  it('strips the leading "//" and one following space, keeps the rest', () => {
    expect(renderButtonsBlock('//   keep inner   spacing')).toContain(
      'keep inner   spacing'
    );
  });

  it('renders a block with only text lines', () => {
    const html = renderButtonsBlock('// only text\n// more text');
    expect(html).toContain('<div class="cmd-text">only text</div>');
    expect(html).toContain('<div class="cmd-text">more text</div>');
    expect(html).not.toContain('<button');
  });
});

describe('renderButtonsBlock copy-only', () => {
  it('copyOnly: true emits data-copy="1"', () => {
    expect(renderButtonsBlock('git status', { copyOnly: true })).toContain('data-copy="1"');
  });

  it('no copyOnly does NOT emit data-copy (not data-copy="0")', () => {
    expect(renderButtonsBlock('git status')).not.toContain('data-copy');
  });

  it('copyOnly: false also does NOT emit data-copy', () => {
    expect(renderButtonsBlock('git status', { copyOnly: false })).not.toContain('data-copy');
  });

  it('copy-only block renders one button per line, all with data-copy="1"', () => {
    const html = renderButtonsBlock('git status\ngit push', { copyOnly: true });
    expect(html.match(/<button/g)!.length).toBe(2);
    expect(html.match(/data-copy="1"/g)!.length).toBe(2);
  });

  it('copy-only + labeled button still works together (data-copy and label)', () => {
    const html = renderButtonsBlock('git status # 状态', { copyOnly: true });
    expect(html).toContain('data-copy="1"');
    expect(html).toContain('状态');
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

describe('parseButtonsFenceInfo', () => {
  it("'buttons' -> { type: 'buttons', copyOnly: false }", () => {
    expect(parseButtonsFenceInfo('buttons')).toEqual({ type: 'buttons', copyOnly: false });
  });

  it("'buttons copy' -> { type: 'buttons', copyOnly: true }", () => {
    expect(parseButtonsFenceInfo('buttons copy')).toEqual({ type: 'buttons', copyOnly: true });
  });

  it("'buttons-json' -> { type: 'buttons-json', copyOnly: false }", () => {
    expect(parseButtonsFenceInfo('buttons-json')).toEqual({ type: 'buttons-json', copyOnly: false });
  });

  it("'buttons-json copy' -> { type: 'buttons-json', copyOnly: true }", () => {
    expect(parseButtonsFenceInfo('buttons-json copy')).toEqual({ type: 'buttons-json', copyOnly: true });
  });

  it('extra whitespace is tolerated: "  buttons   copy  " -> copyOnly true', () => {
    expect(parseButtonsFenceInfo('  buttons   copy  ')).toEqual({ type: 'buttons', copyOnly: true });
  });

  it("'python' -> { type: null, copyOnly: false }", () => {
    expect(parseButtonsFenceInfo('python')).toEqual({ type: null, copyOnly: false });
  });

  it("'bash copy' -> { type: null, copyOnly: false } (copy suffix only applies to buttons types)", () => {
    expect(parseButtonsFenceInfo('bash copy')).toEqual({ type: null, copyOnly: false });
  });

  it("'' (empty) -> { type: null, copyOnly: false }", () => {
    expect(parseButtonsFenceInfo('')).toEqual({ type: null, copyOnly: false });
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

  it('skips "//" text lines — only real buttons are collected', () => {
    const md = ['```buttons', '// 检查', 'git status', '// 提交', 'git push', '```'].join('\n');
    expect(parseButtonsFromMarkdown(md).map((b) => b.command)).toEqual([
      'git status',
      'git push',
    ]);
  });

  it('merges buttons and buttons-json in document order', () => {
    const md = [
      '```buttons',
      'git status',
      '```',
      '```buttons-json',
      '[{"command":"git push","label":"推送"}]',
      '```',
    ].join('\n');
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.map((b) => b.command)).toEqual(['git status', 'git push']);
    expect(btns[1].label).toBe('推送');
  });

  it('carries params from buttons-json', () => {
    const md =
      '```buttons-json\n' +
      '{"command":"git commit -m \\"{{message}}\\"","params":[{"name":"message","required":true}]}\n' +
      '```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns[0].params?.[0]).toEqual({ name: 'message', required: true });
  });

  it('```buttons copy stamps copy: true on collected buttons', () => {
    const md = '```buttons copy\nls\npwd\n```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.length).toBe(2);
    expect(btns.every((b) => b.copy === true)).toBe(true);
  });

  it('```buttons-json copy stamps copy: true', () => {
    const md = '```buttons-json copy\n{ "command": "ls" }\n```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.length).toBe(1);
    expect(btns[0].copy).toBe(true);
  });

  it('normal ```buttons does NOT set copy (undefined)', () => {
    const md = '```buttons\nls\n```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns[0].copy).toBeUndefined();
  });

  it('mixed doc: copy flag is per-block, document order preserved', () => {
    const md = '```buttons\ngit status\n```\n\n```buttons copy\nssh user@host\n```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns.length).toBe(2);
    expect(btns[0].command).toBe('git status');
    expect(btns[0].copy).toBeUndefined();
    expect(btns[1].command).toBe('ssh user@host');
    expect(btns[1].copy).toBe(true);
  });
});

import { substituteParams } from '../src/shared/buttonBlock';

describe('substituteParams', () => {
  // Each value is POSIX single-quote wrapped so special chars (spaces, quotes,
  // ;, $, etc.) are safe in the shell. Empty values stay empty so optional
  // params vanish. Undeclared placeholders are left as-is.
  it('single-quotes a value', () => {
    expect(substituteParams('echo {{msg}}', { msg: 'hi' })).toBe("echo 'hi'");
  });
  it('quotes each of multiple placeholders', () => {
    expect(substituteParams('{{a}} {{b}}', { a: '1', b: '2' })).toBe("'1' '2'");
  });
  it('quotes every occurrence of the same name', () => {
    expect(substituteParams('{{a}}-{{a}}', { a: 'x' })).toBe("'x'-'x'");
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
  it('value with a double quote is safely quoted', () => {
    expect(substituteParams('git commit -m {{message}}', { message: '1"' })).toBe(
      "git commit -m '1\"'"
    );
  });
  it('value with spaces is quoted as one argument', () => {
    expect(substituteParams('git commit -m {{message}}', { message: 'hello world' })).toBe(
      "git commit -m 'hello world'"
    );
  });
  it("value with a single quote is escaped via '\\''", () => {
    expect(substituteParams('echo {{x}}', { x: "it's" })).toBe("echo 'it'\\''s'");
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
  it('keeps param label when present, omits when absent or empty', () => {
    // name stays the {{name}} key; label only governs the form display name.
    const r = parseButtonsJson(JSON.stringify({
      command: 'search {{keyword}} {{nolabel}}',
      params: [
        { name: 'keyword', label: '关键词' },
        { name: 'nolabel' },
        { name: 'blank', label: '   ' },
        { name: 'nonstring', label: 42 },
      ],
    }));
    const params = (r as { buttons: any[] }).buttons[0].params;
    expect(params[0]).toEqual({ name: 'keyword', label: '关键词' });
    // absent label → field not present (form falls back to name)
    expect('label' in params[1]).toBe(false);
    // whitespace-only and non-string labels are dropped (same as a missing label)
    expect('label' in params[2]).toBe(false);
    expect('label' in params[3]).toBe(false);
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

describe('renderButtonsJsonBlock', () => {
  it('renders a button with the template in data-cmd', () => {
    const html = renderButtonsJsonBlock(JSON.stringify({ command: 'echo {{msg}}', label: 'say' }));
    expect(html).toContain('data-cmd="echo {{msg}}"');
    expect(html).toContain('>say<');
  });
  it('omits data-params when the button has no params', () => {
    const html = renderButtonsJsonBlock(JSON.stringify({ command: 'ls' }));
    expect(html).not.toContain('data-params');
  });
  it('serializes params into data-params (attribute-escaped JSON)', () => {
    const html = renderButtonsJsonBlock(
      JSON.stringify({ command: 'x {{p}}', params: [{ name: 'p', required: true }] })
    );
    expect(html).toContain('data-params=');
    expect(html).toContain('&quot;name&quot;');
  });
  it('renders an error block on malformed JSON', () => {
    const html = renderButtonsJsonBlock('{ bad');
    expect(html).toContain('class="cmd-error"');
  });
  it('empty array -> empty string', () => {
    expect(renderButtonsJsonBlock('[]')).toBe('');
  });
});

describe('renderButtonsJsonBlock copy-only', () => {
  it('copyOnly: true emits data-copy="1"', () => {
    expect(renderButtonsJsonBlock('{ "command": "ls" }', { copyOnly: true })).toContain('data-copy="1"');
  });

  it('no copyOnly does NOT emit data-copy', () => {
    expect(renderButtonsJsonBlock('{ "command": "ls" }')).not.toContain('data-copy');
  });
});

describe('buildMdAppend', () => {
  it('empty / whitespace-only body -> returns currentMd unchanged', () => {
    expect(buildMdAppend('# Title\n', '')).toBe('# Title\n');
    // whitespace-only body is treated as empty
    expect(buildMdAppend('# Title\n', '   \n  \n')).toBe('# Title\n');
  });

  it('appends the body verbatim at the end (no wrapping)', () => {
    const out = buildMdAppend('# Title\n\n```buttons\nls\n```', 'pwd');
    expect(out).toBe('# Title\n\n```buttons\nls\n```\n\npwd\n');
  });

  it('keeps a ```buttons fence in the body as-is (no double wrapping)', () => {
    const out = buildMdAppend('# Title\n', '```buttons\npwd\n```');
    expect(out).toBe('# Title\n\n```buttons\npwd\n```\n');
  });

  it('keeps arbitrary markdown (headings / other fences) verbatim', () => {
    const out = buildMdAppend('# Title\n', '## Section\n\n```sh\necho hi\n```');
    expect(out).toBe('# Title\n\n## Section\n\n```sh\necho hi\n```\n');
  });

  it('normalizes trailing whitespace on currentMd to a single blank line separator', () => {
    const out = buildMdAppend('# Title\n\n\n\n', 'pwd');
    expect(out).toBe('# Title\n\npwd\n');
  });

  it('first append to an empty doc has no leading blank line', () => {
    const out = buildMdAppend('', 'pwd');
    expect(out).toBe('pwd\n');
  });

  it('trims surrounding whitespace off the body but keeps interior blank lines', () => {
    const out = buildMdAppend('# Title', 'pwd\n\nls');
    expect(out).toBe('# Title\n\npwd\n\nls\n');
  });
});

describe('buttons comment lines (# at line start)', () => {
  it('parseButtonLine: "# ..." is null (comment, not a button)', () => {
    expect(parseButtonLine('# todo: refactor this')).toBeNull();
    expect(parseButtonLine('#')).toBeNull();
    expect(parseButtonLine('#label-no-space')).toBeNull();
  });

  it('parseButtonLine: leading whitespace before # is still a comment', () => {
    expect(parseButtonLine('  # indented comment')).toBeNull();
  });

  it('renderButtonsBlock: comment lines produce no output (not text, not button)', () => {
    const html = renderButtonsBlock('# hidden note\nls\n# another note');
    expect(html).toBe(
      '<div class="cmd-buttons"><button class="cmd-btn" data-cmd="ls" data-edit="0">ls</button></div>'
    );
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('another');
  });

  it('parseButtonsFromMarkdown: comments excluded from collected buttons', () => {
    const md = '```buttons\n# comment\npwd\n# another\n```';
    const btns = parseButtonsFromMarkdown(md);
    expect(btns).toHaveLength(1);
    expect(btns[0].command).toBe('pwd');
  });

  it('regression: "cmd # label" is NOT a comment (label only when # is mid-line)', () => {
    expect(parseButtonLine('git status # 查看状态')).toEqual({
      command: 'git status',
      label: '查看状态',
      edit: false,
    });
  });

  it('regression: "// text" still renders as visible text, not ignored', () => {
    const html = renderButtonsBlock('// a visible note\nls');
    expect(html).toContain('class="cmd-text"');
    expect(html).toContain('a visible note');
  });
});

describe('substituteCwd', () => {
  it('replaces @/ with cwd when rootDir absent', () => {
    expect(substituteCwd('cd @/a', undefined, '/p')).toBe('cd /p/a');
  });

  it('replaces multiple @/ occurrences', () => {
    expect(substituteCwd('ls @/x @/y', undefined, '/p')).toBe('ls /p/x /p/y');
  });

  it('trailing @/ keeps the slash from original', () => {
    expect(substituteCwd('cd @/', undefined, '/p')).toBe('cd /p/');
  });

  it('does not replace standalone @ (git HEAD shorthand)', () => {
    expect(substituteCwd('git show @', undefined, '/p')).toBe('git show @');
  });

  it('does not replace @~1 (git rebase)', () => {
    expect(substituteCwd('git rebase @~1', undefined, '/p')).toBe('git rebase @~1');
  });

  it('does not replace @ not followed by /', () => {
    expect(substituteCwd('npm --prefix @ run build', undefined, '/p')).toBe('npm --prefix @ run build');
  });

  it('does not replace @/ in the middle of a word', () => {
    expect(substituteCwd('echo me@/x', undefined, '/p')).toBe('echo me@/x');
  });

  it('rootDir takes priority over cwd', () => {
    expect(substituteCwd('cd @/a', '/srv/api', '/p')).toBe('cd /srv/api/a');
  });

  it('empty string rootDir falls back to cwd', () => {
    expect(substituteCwd('cd @/a', '', '/p')).toBe('cd /p/a');
  });

  it('whitespace-only rootDir falls back to cwd', () => {
    expect(substituteCwd('cd @/a', '  ', '/p')).toBe('cd /p/a');
  });

  it('both empty -> ~', () => {
    expect(substituteCwd('cd @/a', undefined, undefined)).toBe('cd ~/a');
  });

  it('both empty string -> ~', () => {
    expect(substituteCwd('cd @/a', '', '')).toBe('cd ~/a');
  });

  it('cwd with ~ kept verbatim for shell to expand', () => {
    expect(substituteCwd('cd @/a', undefined, '~/proj')).toBe('cd ~/proj/a');
  });

  it('rootDir with ~ kept verbatim', () => {
    expect(substituteCwd('cd @/a', '~/api', '/p')).toBe('cd ~/api/a');
  });

  it('trailing slash on anchor is trimmed', () => {
    expect(substituteCwd('cd @/a', '/srv/', undefined)).toBe('cd /srv/a');
  });

  it('anchor containing $ is inserted literally (no replacement-pattern interpretation)', () => {
    expect(substituteCwd('cd @/a', '/tmp/$$', undefined)).toBe('cd /tmp/$$/a');
  });
});
