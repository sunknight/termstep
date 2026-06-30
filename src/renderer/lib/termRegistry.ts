import type { Terminal } from '@xterm/xterm';
import type { PtySpawnOpts } from '../../shared/types';

const terms = new Map<string, Terminal>();

export const termRegistry = {
  set(id: string, t: Terminal) {
    terms.set(id, t);
  },
  get(id: string) {
    return terms.get(id);
  },
  del(id: string) {
    terms.delete(id);
  },
};

// Button injection path: paste respects bracketed-paste; Enter sent separately for run mode.
export function runCommand(toolId: string, command: string, edit: boolean, opts: PtySpawnOpts) {
  const term = termRegistry.get(toolId);
  if (!term) {
    window.api.pty.write(toolId, command + (edit ? '' : '\r'), opts);
    return;
  }
  term.paste(command);
  if (!edit) window.api.pty.write(toolId, '\r', opts);
}
