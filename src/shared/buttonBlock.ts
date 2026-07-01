export interface ButtonParam {
  name: string;
  hint?: string;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface ParsedButton {
  command: string;
  label: string;
  edit: boolean;
  params?: ButtonParam[];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const EDIT_SUFFIX = ' // edit';

export function parseButtonLine(raw: string): ParsedButton | null {
  let line = raw.replace(/\s+$/, '');
  if (line.trim() === '') return null;
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

export function renderButtonsBlock(code: string): string {
  const buttons: ParsedButton[] = [];
  for (const line of code.split('\n')) {
    const b = parseButtonLine(line);
    if (b) buttons.push(b);
  }
  if (buttons.length === 0) return '';
  const items = buttons
    .map((b) => {
      // Only labeled buttons (command # label) get a tooltip — for them the visible
      // text differs from the command, so hovering reveals the full command.
      const tip = b.label !== b.command ? ` data-tip="${escapeAttr(b.command)}"` : '';
      return `<button class="cmd-btn"${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}">${escapeHtml(b.label)}</button>`;
    })
    .join('');
  return `<div class="cmd-buttons">${items}</div>`;
}

// Collect every button declared across all `buttons` and `buttons-json` fenced
// blocks in a markdown doc. Used by the global quick-command dropdown, which
// surfaces one tool's buttons app-wide. Order is document order; duplicates
// across blocks kept. JSON fences are parsed via parseButtonsJson; errors are
// ignored here (the dropdown just shows fewer buttons).
const FENCE_RE = /```(buttons-json|buttons)[^\n]*\n([\s\S]*?)\n?```/g;
export function parseButtonsFromMarkdown(markdown: string): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    const type = match[1];
    const body = match[2] ?? '';
    if (type === 'buttons-json') {
      const r = parseButtonsJson(body);
      // Errors are ignored here: the dropdown just shows fewer buttons. The
      // rendered help page surfaces the error via renderButtonsJsonBlock.
      if ('buttons' in r) out.push(...r.buttons);
    } else {
      for (const line of body.split('\n')) {
        const b = parseButtonLine(line);
        if (b) out.push(b);
      }
    }
  }
  return out;
}

// Substitute {{name}} placeholders in a command template with collected form
// values. A placeholder whose name is not a key in `values` is left untouched
// (so undeclared {{x}} shows up literally and is easy to spot). The result is
// trimmed of leading/trailing whitespace; interior whitespace is preserved.
export function substituteParams(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([^{}]+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m
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
export function renderButtonsJsonBlock(code: string): string {
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
      return `<button class="cmd-btn"${tip} data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}"${paramsAttr}>${escapeHtml(b.label)}</button>`;
    })
    .join('');
  return `<div class="cmd-buttons">${items}</div>`;
}
