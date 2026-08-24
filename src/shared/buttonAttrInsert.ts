/**
 * 编辑器「### 属性快捷插入」的纯逻辑：把 label= / edit / tag= / tag-color=
 * 等属性片段插入 markdown 文本的光标位置。
 *
 * 插入规则（与 buttons 语法对齐）：
 * - 光标所在行已有 ` ### ` 且光标在属性区内 → 在光标处插入（前面有内容则补 `; `）。
 * - 所在行已有 ` ### ` 但光标在其前 → 插到行尾（属性区末尾）。
 * - 所在行没有 ` ### ` → 在行尾追加 ` ### <片段>`。
 * - 片段以 `=` 结尾时，返回的 caret 恰在 `=` 之后——输入框直接聚焦输入值。
 */

export interface InsertAttrResult {
  text: string;
  /** 插入后建议的光标位置（= 结尾片段落在 = 后，其余落在片段后）。 */
  caret: number;
}

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t';
}

/** 在 line 中找 `###` 分隔符 token 的下标（前后须为空白或行边界），找不到返回 -1。
 *  与 buttonBlock.ts 的分隔符语义一致：`a#b`、`####` 都不算。 */
export function findSeparator(line: string): number {
  for (let i = line.indexOf('###'); i >= 0; i = line.indexOf('###', i + 1)) {
    const before = i === 0 ? undefined : line[i - 1];
    const after = i + 3 >= line.length ? undefined : line[i + 3];
    if ((before === undefined || isSpace(before)) && (after === undefined || isSpace(after))) {
      return i;
    }
  }
  return -1;
}

export function insertButtonAttr(text: string, caret: number, attr: string): InsertAttrResult {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', clamped - 1) + 1;
  const nlIdx = text.indexOf('\n', clamped);
  const lineEnd = nlIdx === -1 ? text.length : nlIdx;
  const line = text.slice(lineStart, lineEnd);
  const sepIdx = findSeparator(line);

  let insertPos: number;
  let inserted: string;
  if (sepIdx >= 0) {
    // 属性区起点：### 之后跳过空白。
    let attrStart = sepIdx + 3;
    while (attrStart < line.length && isSpace(line[attrStart])) attrStart++;
    // 光标在属性区内 → 插光标处；否则插行尾（属性区末尾）。
    const inAttrZone = clamped >= lineStart + attrStart;
    insertPos = inAttrZone ? clamped : lineEnd;
    // 前面已有属性内容则补「; 」分隔（已在分隔符/空白上则直接插入）。
    const before = text.slice(lineStart + attrStart, insertPos);
    inserted = before.trim().length > 0 ? `; ${attr}` : attr;
  } else {
    insertPos = lineEnd;
    inserted = ` ### ${attr}`;
  }

  const next = text.slice(0, insertPos) + inserted + text.slice(insertPos);
  // `=` 结尾的片段把 caret 放在 = 后，方便立刻输入值；其余放在片段后。
  const caretInInserted = attr.endsWith('=') ? inserted.length : inserted.length;
  return { text: next, caret: insertPos + caretInInserted };
}

/**
 * 在光标处插入一个空的 `​``buttons` 围栏块，caret 落在围栏内首行（直接输入命令）：
 * - 光标所在行为空行（仅空白）→ 围栏占用该行；
 * - 否则 → 插在当前行之后（新起一行，行尾的 \n 天然分隔前后内容）。
 */
export function insertButtonsFence(text: string, caret: number): InsertAttrResult {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', clamped - 1) + 1;
  const nlIdx = text.indexOf('\n', clamped);
  const lineEnd = nlIdx === -1 ? text.length : nlIdx;
  const line = text.slice(lineStart, lineEnd);

  const blankLine = line.trim().length === 0;
  const insertPos = blankLine ? lineStart : lineEnd;
  const prefix = blankLine ? '' : '\n';
  const FENCE_OPEN = '```buttons\n';
  const inserted = prefix + FENCE_OPEN + '\n```';
  const next = text.slice(0, insertPos) + inserted + text.slice(insertPos);
  return { text: next, caret: insertPos + prefix.length + FENCE_OPEN.length };
}
