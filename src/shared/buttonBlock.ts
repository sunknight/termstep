export interface ParsedButton {
  command: string;
  label: string;
  edit: boolean;
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
    .map(
      (b) =>
        `<button class="cmd-btn" data-cmd="${escapeAttr(b.command)}" data-edit="${b.edit ? '1' : '0'}">${escapeHtml(b.label)}</button>`
    )
    .join('');
  return `<div class="cmd-buttons">${items}</div>`;
}
