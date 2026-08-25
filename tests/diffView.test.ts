import { describe, it, expect } from 'vitest';
import { classifyDiffLine } from '../src/renderer/lib/diffView';

describe('classifyDiffLine', () => {
  it('diff --git / index are file headers', () => {
    expect(classifyDiffLine('diff --git a/tools/x/help.md b/tools/x/help.md')).toBe('file');
    expect(classifyDiffLine('index c7322ab..78c50e1 100644')).toBe('file');
  });

  it('--- a/... and +++ b/... are file headers, NOT del/add', () => {
    expect(classifyDiffLine('--- a/tools/x/help.md')).toBe('file');
    expect(classifyDiffLine('+++ b/tools/x/help.md')).toBe('file');
  });

  it('@@ hunk header', () => {
    expect(classifyDiffLine('@@ -35,11 +35,11 @@ xattr -cr /Applications/TermStep.app')).toBe('hunk');
  });

  it('+/- prefixed content lines are add/del', () => {
    expect(classifyDiffLine('+open https://example.com/')).toBe('add');
    expect(classifyDiffLine('-open https://example.com/')).toBe('del');
    // 只有一个字符的增删行也是内容行
    expect(classifyDiffLine('+')).toBe('add');
    expect(classifyDiffLine('-')).toBe('del');
  });

  it('\\ No newline marker is a note', () => {
    expect(classifyDiffLine('\\ No newline at end of file')).toBe('note');
  });

  it('everything else (including empty line) is context', () => {
    expect(classifyDiffLine(' context line')).toBe('ctx');
    expect(classifyDiffLine('')).toBe('ctx');
    expect(classifyDiffLine('1. 上传DMG到服务器')).toBe('ctx');
  });

  it('mixed realistic chunk', () => {
    const lines = [
      'diff --git a/t/tool.json b/t/tool.json',
      'index 111..222 100644',
      '--- a/t/tool.json',
      '+++ b/t/tool.json',
      '@@ -1,3 +1,3 @@',
      ' {',
      '-  "name": "old"',
      '+  "name": "new"',
      '\\ No newline at end of file',
    ];
    expect(lines.map(classifyDiffLine)).toEqual([
      'file',
      'file',
      'file',
      'file',
      'hunk',
      'ctx',
      'del',
      'add',
      'note',
    ]);
  });
});
