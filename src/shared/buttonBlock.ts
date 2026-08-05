export interface ButtonParam {
  name: string;
  /** Display name shown on the form label; falls back to `name` when absent.
   *  `name` stays the {{name}} placeholder key and the form state key, so a
   *  human-readable label (with spaces/CJK) doesn't touch command substitution. */
  label?: string;
  hint?: string;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface ParsedButton {
  command: string;
  label: string;
  edit: boolean;
  copy?: boolean;
  /** Badge text shown at the right end of the button (a small pill). Set via
   *  the `### tag=...` structured-attrs syntax on a `buttons` line. */
  tag?: string;
  /** Badge color key: `red` / `amber` / `green` / `blue` (default grey when
   *  absent or unrecognized). Set via `### tag-color=red`. */
  tagColor?: string;
  params?: ButtonParam[];
}

/** Allowed badge color keys. Unknown values fall back to the default (grey). */
const TAG_COLORS = new Set(['red', 'amber', 'green', 'blue']);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Parse the info string of a fenced block (everything after the opening ```)
// into a type marker and a copy-only flag. `type` is `'buttons'` or
// `'buttons-json'` when the FIRST whitespace-delimited token is one of those,
// else `null` (the fence is not a buttons block and should render as a normal
// code fence). `copyOnly` is true only when the type is a buttons block AND a
// later token is exactly `copy` — the suffix that makes a block's buttons
// copy-to-clipboard only (no terminal injection). Surrounding/extra whitespace
// is tolerated; other tokens are ignored. Examples:
//   'buttons'          -> { type: 'buttons', copyOnly: false }
//   'buttons copy'     -> { type: 'buttons', copyOnly: true }
//   'buttons-json copy'-> { type: 'buttons-json', copyOnly: true }
//   'bash copy'        -> { type: null, copyOnly: false }  // suffix ignored for non-buttons
//   ''                 -> { type: null, copyOnly: false }
export function parseButtonsFenceInfo(info: string): {
  type: 'buttons' | 'buttons-json' | null;
  copyOnly: boolean;
} {
  const tokens = info.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { type: null, copyOnly: false };
  const first = tokens[0];
  if (first !== 'buttons' && first !== 'buttons-json') {
    return { type: null, copyOnly: false };
  }
  const type: 'buttons' | 'buttons-json' = first;
  const copyOnly = tokens.slice(1).includes('copy');
  return { type, copyOnly };
}

const EDIT_SUFFIX = ' // edit';
// A line whose trimmed content starts with this is rendered as plain text (a
// note/label between buttons), not a button. `//` is positional: at the START
// of a line it means text; the ` // edit` SUFFIX still means edit mode. `//` is
// not a POSIX shell token, so a `//`-leading line is never a real command.
const TEXT_PREFIX = '//';

// Structured-attrs separator: `###` as a whitespace-delimited token (space or
// line-start before it, space or line-end after it). The surrounding-whitespace
// rule mirrors the legacy ` # ` label separator and avoids colliding with
// commands that merely contain `#` (e.g. `echo a#b`, `git log`). `###` found
// OUTSIDE quotes splits a line into `<command> ### <attrs>`, after which the
// legacy ` # ` / ` // edit` rules do NOT apply to that line — one line uses
// EITHER the structured `###` form OR the legacy suffixes, never both. Lines
// without `###` keep parsing exactly as before (full back-compat).

export function parseButtonLine(raw: string): ParsedButton | null {
  let line = raw.replace(/\s+$/, '');
  if (line.trim() === '') return null;
  if (line.trim().startsWith(TEXT_PREFIX)) return null; // text line, not a button
  // Line comment: a trimmed line starting with `#` is a shell-style comment —
  // lives in the md source only, never rendered or collected. Disambiguated
  // from the ` # ` label separator by position: `#` at line START = comment;
  // ` # ` mid-line = label. (No real command starts with `#` — it's a comment
  // in shells too.) Checked before the label split so `# foo` isn't parsed as
  // a (weird) button.
  if (line.trim().startsWith('#')) return null; // line comment, not rendered
  // Structured form: `command ### attrs...`. Find ` ### ` outside quotes; if
  // present, the LEFT part is the command and the RIGHT part is parsed by the
  // attribute parser. The legacy ` # ` / ` // edit` suffixes are intentionally
  // NOT applied to structured lines.
  const attrIdx = findAttrSeparator(line);
  if (attrIdx !== -1) {
    const command = line.slice(0, attrIdx).trim();
    if (command === '') return null;
    const attrs = parseButtonAttrs(line.slice(attrIdx + 3));
    return { command, label: attrs.label ?? command, edit: attrs.edit, ...(attrs.tag !== undefined ? { tag: attrs.tag } : {}), ...(attrs.tagColor !== undefined ? { tagColor: attrs.tagColor } : {}) };
  }
  // Legacy form: trailing ` // edit` suffix, then optional ` # ` label split.
  let edit = false;
  if (line.endsWith(EDIT_SUFFIX)) {
    edit = true;
    line = line.slice(0, -EDIT_SUFFIX.length);
  }
  let command = line.trim();
  let label = command;
  const sep = command.indexOf(' # ');
  if (sep !== -1) {
    label = command.slice(sep + 3).trim();
    command = command.slice(0, sep).trim();
  }
  if (command === '') return null;
  return { command, label: label || command, edit };
}

/** Find the first `###` separator that lies OUTSIDE double-quoted regions,
 *  where `###` is a token: the char before it is whitespace OR it is at the
 *  start of the line, AND the char after it is whitespace OR it is at the end
 *  of the line. Returns the index of the first `#` (the command spans
 *  `line.slice(0, idx)` — caller trims trailing space; attrs span
 *  `line.slice(idx + 3)`). Returns -1 when none. The surrounding-whitespace
 *  rule mirrors the legacy ` # ` label separator and avoids colliding with
 *  commands that merely contain `#` (e.g. `echo a#b`). Tracking `"` skips
 *  quoted command fragments such as `echo "a ### b"`. */
function findAttrSeparator(line: string): number {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // `\"` inside a quoted region is an escaped quote (no toggle); a bare
      // `"` toggles the in-quote state. This mirrors the value parser below.
      if (inQuote && line[i - 1] === '\\') continue;
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && line.startsWith('###', i)) {
      const leftOk = i === 0 || /\s/.test(line[i - 1]);
      const rightOk = i + 3 >= line.length || /\s/.test(line[i + 3]);
      if (leftOk && rightOk) return i;
    }
  }
  return -1;
}

/** Parse the structured attribute string that follows `###` on a buttons line.
 *  Grammar (lenient, degrades gracefully on any error):
 *    attrs := pair (';' pair)*
 *    pair  := [key] ['=' value]      — bare bool (`edit`) or `key=value`
 *    value := bare-token | '"' ... '"'
 *  Recognized keys: `label`, `tag`, `tag-color` (string); `edit`, `copy`
 *  (bool — bare form means true). Unknown keys are ignored silently. A
 *  semicolon inside a quoted value is literal. Malformed input never throws;
 *  the offending pair is skipped so one bad attr doesn't kill the whole button.
 */
function parseButtonAttrs(attrStr: string): {
  label?: string;
  edit: boolean;
  tag?: string;
  tagColor?: string;
} {
  const result = { edit: false };
  let label: string | undefined;
  let tag: string | undefined;
  let tagColor: string | undefined;
  // Split on `;` but respect double-quoted regions (a `;` inside quotes is a
  // literal part of the value, not a pair separator).
  const pairs = splitAttrs(attrStr);
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = findEqOutsideQuote(trimmed);
    let key: string;
    let rawValue: string | undefined;
    if (eq === -1) {
      // Bare boolean token: `edit` ⟹ edit=true. No `=` → treat whole as a bool key.
      key = trimmed.toLowerCase();
      rawValue = 'true';
    } else {
      key = trimmed.slice(0, eq).trim().toLowerCase();
      rawValue = trimmed.slice(eq + 1).trim();
    }
    const value = unquoteValue(rawValue);
    switch (key) {
      case 'edit':
        if (value === 'true' || value === '1') result.edit = true;
        else if (value === 'false' || value === '0') result.edit = false;
        // any other value: ignore (lenient)
        break;
      case 'label':
        if (value) label = value;
        break;
      case 'tag':
        if (value) tag = value;
        break;
      case 'tag-color':
      case 'tagcolor':
        if (value && TAG_COLORS.has(value.toLowerCase())) tagColor = value.toLowerCase();
        break;
      default:
        // Unknown key: ignore silently (forward-compatible).
        break;
    }
  }
  return {
    ...(label !== undefined ? { label } : {}),
    edit: result.edit,
    ...(tag !== undefined ? { tag } : {}),
    ...(tagColor !== undefined ? { tagColor } : {}),
  };
}

/** Split the attrs string on top-level `;`, honoring double-quoted regions. */
function splitAttrs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuote && s[i - 1] === '\\') {
        cur += ch;
        continue;
      }
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (ch === ';' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Find the first top-level `=` (outside quotes) — the key/value split point. */
function findEqOutsideQuote(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuote && s[i - 1] === '\\') continue;
      inQuote = !inQuote;
      continue;
    }
    if (ch === '=' && !inQuote) return i;
  }
  return -1;
}

/** Strip a wrapping pair of double quotes and unescape `\"` → `"`, `\\` → `\`.
 *  A value not wrapped in quotes is returned trimmed as-is. An unpaired quote
 *  is kept literal (no toggle effect) — lenient fallback. */
function unquoteValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\(.)/g, (_m, c: string) => (c === '"' || c === '\\' ? c : '\\' + c));
  }
  return raw;
}

export function renderButtonsBlock(
  code: string,
  opts?: { isRemote?: boolean; copyOnly?: boolean }
): string {
  const remoteAttr = opts?.isRemote ? ' data-remote="1"' : '';
  const copyAttr = opts?.copyOnly ? ' data-copy="1"' : '';
  const items: string[] = [];
  for (const raw of code.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith(TEXT_PREFIX)) {
      // Text line: strip the leading "//" and any whitespace right after it.
      const text = trimmed.replace(/^\/\/\s*/, '');
      if (text === '') continue;
      items.push(`<div class="cmd-text">${escapeHtml(text)}</div>`);
      continue;
    }
    const b = parseButtonLine(raw);
    if (!b) continue;
    // Only labeled buttons (command # label, or ### label=...) get a tooltip —
    // for them the visible text differs from the command, so hovering reveals
    // the full command.
    const tip = b.label !== b.command ? ` data-tip="${escapeAttr(b.command)}"` : '';
    // When a tag is present, render a structured button (label span + tag span)
    // so CSS can flex them apart (label left, badge right). Without a tag the
    // button stays a flat text node — keeping legacy `>label<` assertions valid.
    let inner: string;
    if (b.tag) {
      const tagColorAttr = b.tagColor ? ` data-tag-color="${escapeAttr(b.tagColor)}"` : '';
      inner = `<span class="cmd-label">${escapeHtml(b.label)}</span><span class="cmd-tag"${tagColorAttr}>${escapeHtml(b.tag)}</span>`;
    } else {
      inner = escapeHtml(b.label);
    }
    items.push(
      `<button class="cmd-btn"${copyAttr}${remoteAttr}${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}">${inner}</button>`
    );
  }
  if (items.length === 0) return '';
  return `<div class="cmd-buttons">${items.join('')}</div>`;
}

// Append `body` verbatim as a markdown block to the end of `currentMd`. Used by
// the quick-add "+" flow (append mode): the modal prefills a ```buttons fence
// template, but the body is no longer force-wrapped — the user can edit the
// fence type, drop it for plain text/headings, or paste arbitrary markdown. An
// empty/whitespace body is a no-op (returns currentMd unchanged so the caller
// can skip writing). Trailing whitespace on currentMd is normalized to a single
// blank-line separator; an empty doc gets no leading blank line. Interior blank
// lines in body are preserved verbatim.
export function buildMdAppend(currentMd: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody === '') return currentMd;
  const trimmedMd = currentMd.replace(/\s+$/, '');
  if (trimmedMd === '') return trimmedBody + '\n';
  return trimmedMd + '\n\n' + trimmedBody + '\n';
}

// Collect every button declared across all `buttons` and `buttons-json` fenced
// blocks in a markdown doc. Used by the global quick-command dropdown, which
// surfaces one tool's buttons app-wide. Order is document order; duplicates
// across blocks kept. JSON fences are parsed via parseButtonsJson; errors are
// ignored here (the dropdown just shows fewer buttons). A ` copy` suffix on the
// fence info stamps `copy: true` on every button parsed from that block (Task 2
// routes those buttons to copy-only logic).
const FENCE_RE = /```([^\n]*)\n([\s\S]*?)\n?```/g;
export function parseButtonsFromMarkdown(markdown: string): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    const { type, copyOnly } = parseButtonsFenceInfo(match[1] ?? '');
    if (type === null) continue;
    const body = match[2] ?? '';
    if (type === 'buttons-json') {
      const r = parseButtonsJson(body);
      // Errors are ignored here: the dropdown just shows fewer buttons. The
      // rendered help page surfaces the error via renderButtonsJsonBlock.
      if ('buttons' in r) {
        for (const b of r.buttons) {
          if (copyOnly) b.copy = true;
          out.push(b);
        }
      }
    } else {
      for (const line of body.split('\n')) {
        const b = parseButtonLine(line);
        if (b) {
          if (copyOnly) b.copy = true;
          out.push(b);
        }
      }
    }
  }
  return out;
}

// POSIX single-quote wrap a value so it is safe to splice into a shell command
// (handles spaces, quotes, $, ;, etc.). Empty string stays empty so optional
// params vanish from the command instead of producing an empty '' argument.
// Embedded single quotes are escaped with the standard '\'' sequence.
export function shellQuote(s: string): string {
  if (s === '') return '';
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Substitute {{name}} placeholders in a command template with collected form
// values. Each value is POSIX shell-quoted (see shellQuote) so authors write
// BARE placeholders — e.g. `git commit -m {{message}}`, NOT `"...{{message}}..."`:
// the system supplies the quoting, so a message containing a quote or space is
// still passed as one safe argument. A placeholder whose name is not a key in
// `values` is left untouched (so undeclared {{x}} shows up literally and is
// easy to spot). The result is trimmed of leading/trailing whitespace; interior
// whitespace is preserved.
export function substituteParams(template: string, values: Record<string, string>): string {
  const quoted: Record<string, string> = {};
  for (const k of Object.keys(values)) quoted[k] = shellQuote(values[k]);
  const out = template.replace(/\{\{([^{}]+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(quoted, name) ? quoted[name] : m
  );
  return out.trim();
}

// Parse the body of a ```buttons-json fence. Accepts a single object or an
// array. Entries missing `command` (or params missing `name`) are dropped.
// edit/required are true only on strict === true so that strings like "false"
// or numbers don't sneak in as truthy. Returns {error} on JSON syntax failure
// so the renderer can surface it instead of silently dropping the block.
export function parseButtonsJson(
  code: string
): { buttons: ParsedButton[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const buttons: ParsedButton[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    if (!command) continue;
    const label =
      typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : command;
    const edit = obj.edit === true;
    const params = Array.isArray(obj.params) ? coerceParams(obj.params) : [];
    const btn: ParsedButton = { command, label, edit };
    if (params.length > 0) btn.params = params;
    buttons.push(btn);
  }
  return { buttons };
}

function coerceParams(raw: unknown[]): ButtonParam[] {
  const out: ButtonParam[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) continue;
    const param: ButtonParam = { name };
    if (typeof o.label === 'string' && o.label.trim()) param.label = o.label.trim();
    if (typeof o.hint === 'string') param.hint = o.hint;
    if (Array.isArray(o.options)) {
      const opts = o.options.filter((x): x is string => typeof x === 'string');
      if (opts.length > 0) param.options = opts;
    }
    if (typeof o.default === 'string') param.default = o.default;
    if (o.required === true) param.required = true;
    out.push(param);
  }
  return out;
}

// Render a ```buttons-json fence. Parametrized buttons carry their param spec
// serialized (and attribute-escaped) in data-params so the delegated click
// handler can rebuild the form without a separate registry. A parse failure
// renders a visible error block so the author sees the syntax problem.
export function renderButtonsJsonBlock(
  code: string,
  opts?: { isRemote?: boolean; copyOnly?: boolean }
): string {
  const remoteAttr = opts?.isRemote ? ' data-remote="1"' : '';
  const copyAttr = opts?.copyOnly ? ' data-copy="1"' : '';
  const r = parseButtonsJson(code);
  if ('error' in r) {
    return `<div class="cmd-error">⚠️ buttons-json 解析失败：${escapeHtml(r.error)}</div>`;
  }
  if (r.buttons.length === 0) return '';
  const items = r.buttons
    .map((b) => {
      const paramsAttr = b.params
        ? ` data-params="${escapeAttr(JSON.stringify(b.params))}"`
        : '';
      const tip = b.label !== b.command ? ` data-tip="${escapeAttr(b.command)}"` : '';
      return `<button class="cmd-btn"${copyAttr}${remoteAttr}${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}"${paramsAttr}>${escapeHtml(b.label)}</button>`;
    })
    .join('');
  return `<div class="cmd-buttons">${items}</div>`;
}

// Resolve the anchor for the @/ placeholder: priority rootDir > cwd > ~.
// Returns the anchor without a trailing slash (or ~); @/ carries its own /, so
// joining never doubles it. ~ is NOT expanded: the anchor may be ~/proj, which
// is passed verbatim to the target shell (for a remote tool, that shell's home).
function resolveAnchor(rootDir?: string, cwd?: string): string {
  const r = rootDir?.trim();
  if (r) return r.replace(/\/+$/, '');
  const c = cwd?.trim();
  if (c) return c.replace(/\/+$/, '');
  return '~';
}

// Replace the "tool root" placeholder @/ in a command with the tool anchor
// (rootDir > cwd > ~). Only the @ character is matched and replaced; the / in
// @/ is kept from the original, so a trailing @/ becomes {anchor}/.
// Trigger rule: @ immediately followed by a / (this excludes standalone @,
// @~1, @ followed by space, and other git semantics), AND @ not preceded by a
// letter/digit/underscore (excludes me@/x where @ clings to a word). When the
// anchor is empty, emit ~ and let the shell expand the home directory itself
// (for remote tools, the remote home). Uses a function replacement so that $ in
// the anchor (e.g. /tmp/$$) is inserted literally rather than being interpreted
// as a replacement pattern ($&, $1, ...) — same reason substituteParams does.
export function substituteCwd(command: string, rootDir?: string, cwd?: string): string {
  const base = resolveAnchor(rootDir, cwd);
  return command.replace(/(?<![A-Za-z0-9_])@(?=\/)/g, () => base);
}
