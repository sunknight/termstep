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

// Collect every button declared across all `buttons` fenced blocks in a markdown
// doc. Used by the global quick-command dropdown, which surfaces one tool's
// buttons app-wide. Order is document order; duplicates across blocks kept.
const FENCE_RE = /```buttons[^\n]*\n([\s\S]*?)\n?```/g;
export function parseButtonsFromMarkdown(markdown: string): ParsedButton[] {
  const out: ParsedButton[] = [];
  for (const match of markdown.matchAll(FENCE_RE)) {
    const body = match[1] ?? '';
    for (const line of body.split('\n')) {
      const b = parseButtonLine(line);
      if (b) out.push(b);
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
