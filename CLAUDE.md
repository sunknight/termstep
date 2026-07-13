# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## What this is

`TermStep` — a local macOS **Tauri v2** app that turns CLI commands into clickable menus/buttons. Users define "tools"; each tool has its own persistent terminal and a markdown help page whose ` ```buttons ` fenced blocks render as one-click command buttons. Shells run via portable-pty (wezterm) in real xterm.js terminals rendered by WKWebView.

## Commands

```bash
npm run dev          # tauri dev — Vite dev server (:1420) + Rust window with HMR
npm run build        # tauri build — release dmg (unsigned, host arch)
npm run dev:web      # vite — just the renderer dev server (no native window)
npm run build:web    # vite build — renderer → dist/ (consumed by tauri)
npm run typecheck    # tsc --noEmit on tsconfig.web.json (renderer + shared)
npm run test         # vitest run (node env). Watch: npm run test:watch
npm run icon         # regenerate src-tauri/icons/ from assets/icon.png (after icon edit)
```

Single test file: `npx vitest run tests/buttonBlock.test.ts`
Single test by name: `npx vitest run -t "restart keeps"`

Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (pure/updater/tools/tmux = 55 tests)
Rust check: `cargo check --manifest-path src-tauri/Cargo.toml`

**设置版本号**：`npm run version:set 0.8.2` —— 一键同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock`（termstep 包那一处）。不要手动逐个改，容易漏 Cargo.lock。

## Architecture

Two sides, wired by Tauri v2:

- **Rust backend** (`src-tauri/src/`): `main.rs` (thin entry), `lib.rs` (Builder + setup + State init + menu_event), `pty.rs` (portable-pty pool keyed by toolId), `tools.rs` (scanner + fetchRemoteMarkdown + sensitive-path guard), `tool_io.rs` (tool CRUD/bundle/quick), `watcher.rs` (notify file watch → emit `tools:changed`), `updater.rs` (reqwest manifest check → emit `update:state`), `cwd.rs` (lsof live cwd), `menu.rs` (native macOS menu), `seed.rs` (first-run default tool), `commands.rs` (`#[tauri::command]` thin wrappers), `types.rs` (Rust duals of shared TS types), `pure.rs` (pure data conversion: mergeToolJson/buildButtonsAppend/serializeTools/parseToolMeta/slugify), `tmux.rs` (session name sanitize + argv).
- **React renderer** (`src/renderer/`): React 18 (StrictMode on in dev). `App.tsx` is the 3-column layout (sidebar / terminal / help-or-editor). `components/`, `hooks/` (`useTools`, `useUpdateState`, `useTauriEvent`), `lib/` (`api.ts` = Tauri invoke wrappers, `termRegistry`, `markdown`). The renderer talks to Rust ONLY through `lib/api.ts` (invoke) + `useTauriEvent` (listen) — never direct `window.*`.
- **shared** (`src/shared/`): `types.ts` (types + IPC channel-name constants), `toolConfig.ts` (`parseToolMeta`), `buttonBlock.ts` (the `buttons` fence renderer), `bundle.ts` (import/export), `toolJson.ts` (merge), `tmux.ts`, `peekController.ts`, `dangerous.ts`. Pure TS, used by renderer; the backend has Rust duals in `pure.rs`/`types.rs`.

### Tools are data on disk, not code
Each tool is a directory `userData/tools/<id>/` holding `tool.json` (name/icon/order/cwd/shell/env/tmux/initCommands/mdUrl) and `help.md`. The entire UI is derived from scanning that directory (`tools.rs: scan_tools` → `parse_tool_meta`). Editing a tool in-app just writes these files back.

### IPC contract
`src/shared/types.ts` defines an `IPC` constant object with every channel name; renderer and Rust share the names (Rust side: command names are the channel names with `:` → `_`, e.g. `tools:list` → `tools_list`). Adding an IPC call means: add the channel constant → add `#[tauri::command]` in `commands.rs` → register in `lib.rs` `generate_handler!` → add a method on `api` in `src/renderer/lib/api.ts`. Cross-command state lives in `tauri::State<T>` (managed in `setup()`).

### UI auto-refreshes from disk
`watcher.rs` watches `toolsDir` with `notify` (debounced ~200ms) and emits `tools:changed` with a fresh `ScanResult`; the renderer's `useTools` hook subscribes via `useTauriEvent`. Creating / editing / reordering / deleting a tool (which the commands do by writing files) refreshes the UI with no manual state plumbing.

### Terminals: lazy + persistent per tool
`TerminalPane` mounts one `TerminalView` per tool and toggles `display:none`. The xterm `Terminal` and its portable-pty are created **lazily on first activation**, then kept alive (keyed by toolId in `PtyService`) across tool switches — switching tools only toggles visibility and re-fits. `termRegistry` maps toolId → Terminal so the help-button command runner (`lib/termRegistry.ts: runCommand`) can paste into the correct terminal.

### Shell spawn
Tool meta `cwd`/`shell`/`env` flow as `PtySpawnOpts` into `PtyService::ensure` (the single spawn path used by `open`/`write`/`restart`). `cwd` is `expand_home`'d (`~` → homedir); default shell is `$SHELL` then `/bin/zsh`. The `desired` map remembers each terminal's size so respawns keep their dimensions. A reader thread per pty emits `pty:data`; on EOF a **generation-guarded** eviction runs (see gotchas).

### `buttons` markdown extension
`renderer/lib/markdown.ts` overrides the `fence` rule: a ` ```buttons ` fence is parsed by `shared/buttonBlock.ts` into `<button class="cmd-btn">` elements (one per line). A trailing ` // edit` on a line makes it paste-without-Enter (edit mode); otherwise the command is pasted and Enter is sent. A line whose trimmed content **starts with** `//` is rendered as a plain-text label (`<div class="cmd-text">`) instead of a button. A line whose trimmed content **starts with** `#` is a shell-style **comment** — it stays in the md source only and is never rendered. `HelpPane` delegates clicks on `.cmd-btn` to `runCommand`; text rows have no `data-cmd` and are ignored.

### Storage location
Tools live under `app.path().app_data_dir()/tools` = `~/Library/Application Support/TermStep/tools` (Tauri v2's `app_data_dir` on macOS equals Electron's userData path — they're derived from the same bundle identifier `local.termstep`, so a rename to/from Electron needs no data migration).

## Gotchas (non-obvious, learned the hard way)

- **Tauri v2 clipboard is a plugin** (`tauri-plugin-clipboard-manager`); this app uses the `arboard` crate directly instead (simpler, no capability config). Used by terminal copy/paste, copy-on-select, OSC 52.
- **`notify` 6.x API**: `recommended_watcher` takes a single callback (not the old `(callback, Config)` pair). Wrap an mpsc channel in a closure.
- **Never open xterm in a `display:none` container** — its renderer won't paint the prompt. Create the `Terminal` only once the tab is visible, and call `fit()` inside a `requestAnimationFrame` after showing.
- **portable-pty lifecycle race**: a killed shell's reader thread hits EOF asynchronously. `PtyService` guards eviction by generation number (`entry.generation == my_gen`), so restarting a terminal doesn't let the old shell's late EOF evict the new one or reset its size. The reader thread uses `try_state` (not `state`) so it tolerates app teardown. Do **not** clear `desired` on exit — terminal size outlives any single shell.
- **PTY spawn must use login shell (`-l`)**: a GUI app inherits a minimal launchd PATH lacking `/opt/homebrew/bin`; `-l` makes zsh source `~/.zprofile`. Without it, `git`/`brew` are "not found" in the packaged app.
- **portable-pty has no `name` field** (unlike node-pty) — `TERM=xterm-256color` must be set via `cmd.env("TERM", ...)`. Same for `LANG`/`LC_CTYPE`/`COLORTERM` (set only when unset, to avoid clobbering a user-set locale — otherwise BSD `ls` shows `?` for non-ASCII filenames).
- **`take_writer` can be called only once** per pty; `ensure` calls it once and stores the writer in a `Mutex<Option<...>>`. `try_clone_reader` is called once and handed to the reader thread. The `master` is kept in the entry to support later `resize`.
- **Packaging is unsigned and host-arch** — recipients hit macOS Gatekeeper ("damaged / can't verify developer"); they must right-click→Open or run `xattr -cr "/Applications/TermStep.app"`. Signing + notarization need an Apple Developer ID.
- **dev server port 1420** is fixed (must match `tauri.conf.json` `devUrl` and `vite.config.ts` `server.port` with `strictPort`). If `npm run dev` fails with "Port 1420 is already in use", a previous Vite didn't exit cleanly: `lsof -ti:1420 | xargs kill -9`.
- **icons/ is gitignored** — generated by `npm run icon` (`tauri icon assets/icon.png`) from `assets/icon.png` (tracked). Don't commit the generated multi-size set.
- **Cargo.lock is tracked** (Tauri is a binary project).
