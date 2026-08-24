import { describe, expect, it } from 'vitest';
import { findSeparator, insertButtonAttr, insertButtonsFence } from '../src/shared/buttonAttrInsert';

describe('findSeparator', () => {
  it('识别标准 ### 分隔符', () => {
    expect(findSeparator('cmd ### label=a')).toBe(4);
    expect(findSeparator('cmd ###label=a')).toBe(-1); // 后贴字符不算
    expect(findSeparator('cmd### label=a')).toBe(-1); // 前贴字符不算
    expect(findSeparator('cmd ###')).toBe(4); // 行尾边界
    expect(findSeparator('### label=a')).toBe(0); // 行首边界
  });
  it('不把井号内容/多井号误判为分隔符', () => {
    expect(findSeparator('echo a#b')).toBe(-1);
    expect(findSeparator('echo #### x')).toBe(-1);
    expect(findSeparator('# 注释')).toBe(-1);
    expect(findSeparator('git log --oneline # 标签')).toBe(-1);
  });
});

describe('insertButtonAttr', () => {
  const doc = '```buttons\ngit push ### label=推送\ngit status\n```';

  it('光标在属性区内 → 插到光标处，补 ; 分隔', () => {
    const caret = doc.indexOf('推送') + '推送'.length; // label=推送|
    const r = insertButtonAttr(doc, caret, 'edit');
    expect(r.text).toContain('git push ### label=推送; edit');
    expect(r.caret).toBe(doc.indexOf('推送') + '推送'.length + '; edit'.length);
  });

  it('光标在 ### 之前 → 插到行尾', () => {
    const caret = doc.indexOf('git push'); // 行首
    const r = insertButtonAttr(doc, caret, 'edit');
    expect(r.text).toContain('git push ### label=推送; edit');
  });

  it('所在行没有 ### → 行尾追加 ### 片段', () => {
    const caret = doc.indexOf('git status') + 4;
    const r = insertButtonAttr(doc, caret, 'tag=常用');
    expect(r.text).toContain('git status ### tag=常用');
  });

  it('= 结尾片段的 caret 落在 = 后（便于直接输入值）', () => {
    const caret = doc.indexOf('git status');
    const r = insertButtonAttr(doc, caret, 'label=');
    expect(r.text).toContain('git status ### label=');
    const at = r.text.indexOf('git status ### label=') + 'git status ### label='.length;
    expect(r.caret).toBe(at);
  });

  it('光标恰在 ### 之后空白上 → 直接插入不补分隔', () => {
    const line = 'cmd ### ';
    const r = insertButtonAttr(line, line.length, 'edit');
    expect(r.text).toBe('cmd ### edit');
    expect(r.caret).toBe(line.length + 'edit'.length);
  });

  it('多行文档中只影响光标所在行', () => {
    const text = 'a ### x\nb\nc ### y';
    const r = insertButtonAttr(text, text.indexOf('b') + 1, 'edit');
    expect(r.text).toBe('a ### x\nb ### edit\nc ### y');
  });

  it('光标越界时按文本端点兜底', () => {
    const r = insertButtonAttr('cmd ### a', 999, 'edit');
    expect(r.text).toBe('cmd ### a; edit');
  });
});

describe('insertButtonsFence', () => {
  it('空行：围栏占用该行，光标落在围栏内', () => {
    const text = '```buttons\nls\n```\n\n尾注';
    const caret = text.indexOf('\n\n') + 1; // 空行内（两个 \n 之间）
    const r = insertButtonsFence(text, caret);
    const open = r.text.lastIndexOf('```buttons\n', r.caret);
    expect(open).toBeGreaterThan(0);
    expect(r.caret).toBe(open + '```buttons\n'.length);
    expect(r.text).toContain('```\n```buttons\n\n```\n尾注');
  });

  it('有内容行：插到当前行之后', () => {
    const text = '# 标题\n正文';
    const r = insertButtonsFence(text, 2);
    expect(r.text).toBe('# 标题\n```buttons\n\n```\n正文');
    expect(r.caret).toBe('# 标题\n'.length + '```buttons\n'.length);
  });

  it('文本末尾无换行也能插入', () => {
    const r = insertButtonsFence('ls -la', 6);
    expect(r.text).toBe('ls -la\n```buttons\n\n```');
  });

  it('空白（非空）行视为空行处理', () => {
    const text = 'a\n   \nb';
    const r = insertButtonsFence(text, 3);
    expect(r.text.startsWith('a\n```buttons')).toBe(true);
  });
});
