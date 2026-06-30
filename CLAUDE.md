# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gui_anything` (formerly `cmd_gui`) — a local macOS Electron app that turns CLI commands into clickable menus/buttons. Users define "tools"; each tool has its own persistent terminal and a markdown help page whose ` ```buttons ` fenced blocks render as one-click command buttons. Shells run via node-pty in real xterm.js terminals.

## Commands

```bash
npm run dev          # electron-vite dev — launches the Electron window with HMR
npm run typecheck    # tsc --noEmit on tsconfig.node.json (main/preload/shared) AND tsconfig.web.json (renderer)
npm run test         # vitest run (node env). Watch: npm run test:watch
npm run build        # electron-vite production build → out/{main,preload,renderer}
npm run rebuild      # electron-builder install-app-deps (rebuild node-pty for Electron) + chmod spawn-helper
npm run package      # build + electron-builder → release/*.dmg (unsigned, host arch only)
```

Single test file: `npx vitest run tests/ptyService.test.ts`
Single test by name: `npx vitest run -t "restart keeps"`

## Architecture

Three Electron processes, all TypeScript, wired by electron-vite:

- **main** (`src/main/`): `index.ts` (lifecycle, window, wires services), `ptyService.ts` (node-pty pool keyed by toolId), `toolManager.ts` (chokidar watcher), `toolsScanner.ts` (reads toolsDir), `ipc.ts` (ipcMain handlers), `seed.ts` (first-run default tool).
- **preload** (`src/preload/`): `index.ts` exposes a typed `window.api` via contextBridge (contextIsolation on, nodeIntegration off). The shape of this `api` object **is** the IPC contract.
- **renderer** (`src/renderer/`): React 18 (StrictMode on in dev). `App.tsx` is the 3-column layout (sidebar / terminal / help-or-editor). Plus `components/`, `hooks/useTools.ts`, `lib/` (`termRegistry`, `markdown`).
- **shared** (`src/shared/`): `types.ts` (types **and** the `IPC` channel-name constants), `toolConfig.ts` (`parseToolMeta`), `buttonBlock.ts` (the `buttons` fence renderer).

### Tools are data on disk, not code
Each tool is a directory `userData/tools/<id>/` holding `tool.json` (name/icon/order/cwd/shell/env) and `help.md`. The entire UI is derived from scanning that directory (`toolsScanner.ts` → `parseToolMeta`). Editing a tool in-app just writes these files back.

### IPC contract
`src/shared/types.ts` defines an `IPC` constant object with every channel name; all three processes import it. Adding an IPC call means: add the channel constant → add `ipcMain.handle` in `ipc.ts` → add a method on `window.api` in `preload/index.ts`. The preload `api` type is surfaced to the renderer via `global.d.ts`.

### UI auto-refreshes from disk
`ToolManager` watches `toolsDir` with chokidar (debounced ~200ms) and broadcasts `TOOLS_CHANGED` with a fresh `ScanResult`; the renderer's `useTools` hook subscribes. Creating / editing / reordering / deleting a tool (which the IPC handlers do by writing files) refreshes the UI with no manual state plumbing.

### Terminals: lazy + persistent per tool
`TerminalPane` mounts one `TerminalView` per tool and toggles `display:none`. The xterm `Terminal` and its node-pty are created **lazily on first activation**, then kept alive (keyed by toolId in `PtyService`) across tool switches — switching tools only toggles visibility and re-fits. `termRegistry` maps toolId → Terminal so the help-button command runner (`lib/termRegistry.ts: runCommand`) can paste into the correct terminal. Opening xterm while its container is `display:none` breaks its renderer — see gotchas.

### Shell spawn
Tool meta `cwd`/`shell`/`env` flow as `PtySpawnOpts` into `PtyService.ensure` (the single spawn path used by `open`/`write`/`restart`). `cwd` is `expandHome`'d (`~` → homedir); default shell is `$SHELL` then `/bin/zsh`. The `desired` map remembers each terminal's size so respawns keep their dimensions.

### `buttons` markdown extension
`renderer/lib/markdown.ts` overrides the `fence` rule: a ` ```buttons ` fence is parsed by `shared/buttonBlock.ts` into `<button class="cmd-btn">` elements (one per line). A trailing ` // edit` on a line makes it paste-without-Enter (edit mode); otherwise the command is pasted and Enter is sent. `HelpPane` delegates clicks on `.cmd-btn` to `runCommand`.

### Storage location & rename migration
Tools live under `app.getPath('userData')/tools`. Because userData is derived from the app name, `index.ts: migrateOldTools()` does a one-time carry-forward of tools created under previous app names (`cmd-gui`, `cmd_gui`) so a rename doesn't orphan user data. If you rename the app again, extend that list.

## Gotchas (non-obvious, learned the hard way)

- **Electron `window.prompt()` is not implemented** — it returns `null` silently (no dialog). `confirm`/`alert` work. Use a custom UI for text input.
- **Never open xterm in a `display:none` container** — its renderer won't paint the prompt. Create the `Terminal` only once the tab is visible, and call `fit()` inside a `requestAnimationFrame` after showing.
- **node-pty is a native module**: rebuild for Electron's Node ABI (`npm run rebuild`) before packaging, keep it out of asar (`asarUnpack: '**/node-pty/**'`), and its `spawn-helper` binary must be executable (`postinstall`/`rebuild` chmod it). A packaged app that silently fails to spawn shells usually means a missing rebuild.
- **pty lifecycle race**: a killed shell's `onExit` fires asynchronously. `PtyService` guards eviction by identity (`this.ptys.get(id) === p`) so restarting a terminal doesn't let the old shell's late exit evict the new one or reset its size. Do **not** drop `desired` on exit — terminal size outlives any single shell.
- **Packaging is unsigned and host-arch by default** — recipients hit macOS Gatekeeper ("damaged / can't verify developer"); they must right-click→Open or run `xattr -cr "/Applications/gui_anything.app"`. To support Intel Macs, set `mac.target` arch to `[arm64, x64]` (or `universal`). Signing + notarization need an Apple Developer ID.
- **ptyService tests are live and timing-based**: they spawn real shells and poll streamed output with `setInterval`, so they need a real `$SHELL` and can be slow (~1s each).
