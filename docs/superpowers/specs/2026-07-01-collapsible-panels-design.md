# Collapsible side panels with hover "peek"

**Date:** 2026-07-01
**Status:** Approved (design phase)
**Scope:** Renderer-only UI change in `gui_anything` (Electron + React). No main/preload/IPC changes.

## Goal

Let the user collapse the left tool list (`Sidebar`) and the right tool docs (`HelpPane`) into the terminal title bar, giving the terminal the full window width. When collapsed, each panel is reachable via a hover-open floating "peek" that stays open long enough for the user to move the pointer into it and click.

## Current layout (context)

`.app` is a flex row with three children:

```
.sidebar (resizable, 140–380px, default 180, width persisted in localStorage)
.terminal-area (flex: 1)
   .term-header   → cwd (left) | ⚡快捷命令 + ↻重启 (right)
   .term-pane-wrap → xterm terminals (one per tool, visibility-toggled)
.help-area (fixed 340px) → tool docs or the editor
```

The terminal (`TerminalView.tsx`) already has a `ResizeObserver` that calls xterm `fit()` when its container resizes. Collapsing/expanding the side panels only changes the terminal's width (the terminal stays mounted and visible), so refit is handled automatically — no new xterm/`display:none` hazards.

## Requirements

### Layout states

**Expanded** — identical to today, plus a collapse toggle at each end of the term-header:

```
┌─────────┬───────────────────────────────┬──────────────┐
│ sidebar │ ‹  📂 cwd      ⚡快捷 ↻重启  › │  help/docs   │
│  tools  ├───────────────────────────────┤              │
│  list   │          terminal             │              │
└─────────┴───────────────────────────────┴──────────────┘
   ←resizable→                     ←340px→
```

**Collapsed** — the freed width goes to the terminal; toggles become panel icons:

```
┌────────────────────────────────────────────────────────┐
│ ☰                                       📖             │
├────────────────────────────────────────────────────────┤
│                   terminal (full width)                │
└────────────────────────────────────────────────────────┘
```

**Collapsed + hovering a toggle** — the panel content floats over the terminal (overlay only; the terminal is not pushed and keeps full width):

```
┌─────────┬────────────────────────────────────────────┐
│░peek░░░░│ ☰                            📖            │
│░tools░░░├────────────────────────────────────────────┤
│░list░░░░│                                            │
│░180px░░░│           terminal (still full width)      │
└─────────┴────────────────────────────────────────────┘
```

### Toggle behavior

- A toggle for each side lives **permanently in the term-header** — a left slot for the sidebar toggle and a right slot for the help toggle, flanking the existing cwd + actions.
- **Expanded state:** the toggle shows a chevron (`‹` for sidebar, `›` for help). Click → collapse that side.
- **Collapsed state:** the toggle shows a panel icon (`☰` for the tool list, `📖` for the docs).
  - **Click** the icon → re-expand (re-dock the panel at its stored width).
  - **Hover** the icon → open the peek.
- The two sides are independent; either, both, or neither may be collapsed.

### Peek (hover float) behavior

- Rendered via `createPortal(..., document.body)` at `position: fixed`, anchored below its toggle, at the panel's normal width (sidebar peek: the sidebar's stored width; help peek: 340px), spanning the full height below the header.
- Overlay only — the terminal keeps the full width while a peek is open.
- **Open:** on pointer entering the collapsed toggle. (A small open delay, ~150 ms, avoids flicker on accidental passes.)
- **Close (decided with user):** ~300–400 ms after the pointer leaves **both** the toggle and the peek (grace delay so the user can move the pointer from the toggle into the peek without it snapping shut). `Esc` also closes.
- **Sidebar peek:** selecting a tool closes the peek (so the terminal switches to the new tool). **Help peek:** running a command button keeps the peek open (the user may run several in a row).
- Only one peek is open at a time; opening the other side replaces the current one.

### Persistence

- Collapse state persists across app restarts in `localStorage`:
  - `gui-anything:sidebar-collapsed` (`'1'` / `'0'`)
  - `gui-anything:help-collapsed` (`'1'` / `'0'`)
- Default on first run / unset: both expanded (today's behavior).

## Component structure

- **`App.tsx`** owns three pieces of state:
  - `sidebarCollapsed: boolean` (initialized from localStorage, persisted on change)
  - `helpCollapsed: boolean` (same)
  - `peek: 'sidebar' | 'help' | null`
- **New `PanelToggle`** component (rendered twice in the term-header):
  - Props: `side`, `collapsed`, `icon` (the panel glyph), `onToggle`, and `peekContent` (the React node to float when collapsed).
  - Expanded → renders the chevron button; click calls `onToggle` (collapse).
  - Collapsed → renders the icon button; click calls `onToggle` (expand); hover/leave drives the peek open/close. PanelToggle is the component that **renders the `Peek`** (using `peekContent`) when collapsed and hovered.
- **New `Peek`** component (reused for both sides):
  - Props: `open`, `anchorRef` (the toggle button), `side` (left/right, for anchoring + width), `onClose`, `children`.
  - Renders a `position: fixed` panel via `createPortal`; positions itself under the toggle, pinned to the side edge, full height below the header.
  - Owns the grace-delay close timer + `Esc` handling; calls `onClose` when the pointer has been off both the toggle and the panel for the grace delay, or on `Esc`.
  - The peek timing logic (open delay, close grace delay, Esc) is extracted into a small `usePeek` hook so it can be unit-tested in isolation.
- **Docked vs. peek rendering (single source of truth):** `App` builds each panel's element once — e.g. `const sidebarContent = <Sidebar .../>`. When that side is **expanded**, `App` renders `sidebarContent` in the docked slot. When **collapsed**, `App` passes the **same** `sidebarContent` to `<PanelToggle peekContent={sidebarContent} />`, and `PanelToggle` floats it inside the `Peek`. The tool-list and doc logic therefore can't drift between docked and floating views.
  - The sidebar peek's "select a tool closes the peek" behavior is implemented by having `App` pass an `onSelect` that both selects the tool and clears `peek`.

## Files touched (expected)

- `src/renderer/App.tsx` — collapse/peek state, term-header toggle slots, conditional docked-vs-peek rendering.
- `src/renderer/components/PanelToggle.tsx` — **new**.
- `src/renderer/components/Peek.tsx` — **new**.
- `src/renderer/hooks/usePeek.ts` — **new** (extracted timing logic, unit-testable).
- `src/renderer/styles.css` — styles for `.panel-toggle`, `.peek`, header slot layout, collapsed-state widths (sidebar/help width → 0 when collapsed so flex gives the width to `.terminal-area`).
- `src/renderer/components/Sidebar.tsx` — minor: when rendered inside a peek it should not render its own resizer (resizing a floating peek is out of scope).
- Tests: `tests/usePeek.test.ts` (new, vitest/jsdom).

No changes to `main/`, `preload/`, `shared/`, or IPC.

## Out of scope (YAGNI)

- No elaborate animation choreography — a simple fade or slide on the peek only.
- No "peek both sides simultaneously" mode (one peek at a time).
- No resizing the help panel (stays 340px). The sidebar keeps its existing resizer **when expanded**; the peek is not resizable.
- No changes to the editor (`EditorPane`) placement — it still occupies the help column when editing; the help toggle collapses it like docs.

## Edge cases

- **No active tool:** toggles still render; the help peek shows the "无选中工具" placeholder as today.
- **Editing a tool:** if the help side is collapsed while the editor is open, expanding re-shows the editor; the peek, when help is collapsed, shows whatever the docked help area would (editor or docs).
- **Window very narrow:** peek widths are fixed (sidebar stored width / 340px); if they exceed viewport width they clip rather than push the terminal — acceptable, matches docked behavior.
- **Terminal refit:** handled by the existing `ResizeObserver` in `TerminalView.tsx`; verify during implementation that a collapse/expand triggers it (it should, since width changes).

## Testing

- **Unit (vitest, jsdom):** `usePeek` — open-on-enter, grace-delay close-on-leave, `Esc` close, auto-close-on-select flag. Use fake timers.
- **Manual:**
  - Collapse each side → terminal widens and refits; toggle becomes icon.
  - Hover collapsed toggle → peek appears and stays; move pointer into peek → stays.
  - Move pointer away → closes after grace delay; `Esc` → closes.
  - In sidebar peek, click a tool → peek closes, terminal switches.
  - In help peek, click a command button → command runs, peek stays.
  - Click collapsed icon → re-expands at stored width.
  - Restart app → collapse state persisted.
  - Resize sidebar while expanded → stored width still used for peek width after collapse.
