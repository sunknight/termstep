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
  params?: ButtonParam[];
}

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

export function parseButtonLine(raw: string): ParsedButton | null {
  let line = raw.replace(/\s+$/, '');
  if (line.trim() === '') return null;
  if (line.trim().startsWith(TEXT_PREFIX)) return null; // text line, not a button
  // Line comment: a trimmed line starting with `#` is a shell-style comment —
  // lives in the md source only, never rendered or collected. Disambiguated
  // from the ` # ` label separator by position: `#` at line START = comment;
  // ` # ` mid-line = label. (No real command starts with `#` — it's a comment
  // in shells too.) Checked before the label split so `# foo` isn't parsed as a
  // (weird) button.
  if (line.trim().startsWith('#')) return null; // line comment, not rendered
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
    // Only labeled buttons (command # label) get a tooltip — for them the visible
    // text differs from the command, so hovering reveals the full command.
    const tip = b.label !== b.command ? ` data-tip="${escapeAttr(b.command)}"` : '';
    items.push(
      `<button class="cmd-btn"${copyAttr}${remoteAttr}${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}">${escapeHtml(b.label)}</button>`
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
