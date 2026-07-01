# Collapsible Side Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the left tool list (`Sidebar`) and right tool docs (`HelpPane`) collapsible into the terminal title bar, giving the terminal full width; collapsed panels are reachable via a hover-open floating "peek" that stays open long enough to click.

**Architecture:** App owns two persisted booleans (`sidebarCollapsed`, `helpCollapsed`). A permanent `PanelToggle` sits at each end of the term-header (chevron when expanded, panel icon when collapsed). When collapsed, hovering the toggle opens a `Peek` — a `createPortal` overlay that renders the *same* panel content used when docked, so there is one source of truth. Peek open/close timing lives in a pure, unit-tested `PeekController` class (open after `openDelay`, close after `closeDelay` grace period, immediate `closeNow`); a thin `usePeek` hook adapts it to React mouse events + Esc. The terminal's existing `ResizeObserver` auto-refits on width change, so no new xterm handling is needed.

**Tech Stack:** React 18, TypeScript, electron-vite, vitest (node environment + fake timers).

## Global Constraints

- **Renderer-only change.** No edits to `src/main/`, `src/preload/`, `src/shared/`, or any IPC channel. The preload `api` is unchanged.
- **Persistence keys** (localStorage, values `'1'` / `'0'`): `gui-anything:sidebar-collapsed`, `gui-anything:help-collapsed`. Reuse the existing `gui-anything:sidebar-width` key for sidebar width (do not rename).
- **Peek timing defaults:** `openDelay` = 150 ms, `closeDelay` = 350 ms.
- **Icon glyphs:** collapsed sidebar toggle = `☰`; collapsed help toggle = `📖`; expanded chevrons = `‹` (left/sidebar) and `›` (right/help).
- **Help panel width** stays 340 px (existing `.help-area`). The sidebar keeps its existing resizer when expanded/docked; the peek is not resizable.
- **Sidebar peek closes on any click inside it** (selecting a tool, etc.). **Help peek stays open on click** (running several commands). This is controlled by a single per-side boolean (`closePeekOnClick`).
- **Default state:** both panels expanded (today's behavior) when the localStorage keys are unset.
- **Verification commands:** `npm run typecheck` (runs `tsc --noEmit` on both tsconfigs), `npm run test` (vitest run), single test `npx vitest run tests/peekController.test.ts`, manual `npm run dev`.
- **Not a git repository** — tasks end with a verify-checkpoint, not a commit. Do not run `git` commands.

---

## File Structure

**Create:**
- `src/renderer/lib/peekController.ts` — pure peek-timing state machine (timers + transitions). Fully unit-tested.
- `tests/peekController.test.ts` — vitest, node env, fake timers.
- `src/renderer/hooks/usePeek.ts` — React adapter over `PeekController`; returns `{ open, triggerProps, contentProps, close }`; adds Esc-to-close.
- `src/renderer/components/Peek.tsx` — presentational `createPortal` overlay; positions itself under the toggle, full height, pinned to a side.
- `src/renderer/components/PanelToggle.tsx` — the header toggle button (chevron/icon); uses `usePeek`; renders `Peek` with `peekContent` when collapsed + open.

**Modify:**
- `src/renderer/components/Sidebar.tsx` — add optional `floating?: boolean` prop; when true, omit the resizer handle (peek is not resizable).
- `src/renderer/App.tsx` — add the two persisted collapse states; build shared `sidebarContent` / `helpContent` elements; render docked panel only when expanded; add two `PanelToggle` slots in the term-header.
- `src/renderer/styles.css` — add `.panel-toggle`, `.peek`, and term-header slot rules.

---

## Task 1: PeekController (pure timing logic) — TDD

**Files:**
- Create: `src/shared/peekController.ts`
- Test: `tests/peekController.test.ts`

**Interfaces:**
- Produces: `export class PeekController`, constructed as `new PeekController(opts?: { openDelay?: number; closeDelay?: number; onChange?: (open: boolean) => void })`. Public methods/fields: `get isOpen(): boolean`, `enter(): void`, `leave(): void`, `closeNow(): void`, `dispose(): void`.

- [ ] **Step 1: Write the failing tests**

Create `tests/peekController.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeekController } from '../src/renderer/lib/peekController';

describe('PeekController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens after the open delay on enter()', () => {
    const c = new PeekController({ openDelay: 100, closeDelay: 300 });
    expect(c.isOpen).toBe(false);
    c.enter();
    expect(c.isOpen).toBe(false); // not yet
    vi.advanceTimersByTime(100);
    expect(c.isOpen).toBe(true);
  });

  it('does not open if leave() cancels before the open delay', () => {
    const c = new PeekController({ openDelay: 100, closeDelay: 300 });
    c.enter();
    vi.advanceTimersByTime(40);
    c.leave();
    vi.advanceTimersByTime(200);
    expect(c.isOpen).toBe(false);
  });

  it('closes after the close delay on leave()', () => {
    const c = new PeekController({ openDelay: 100, closeDelay: 300 });
    c.enter();
    vi.advanceTimersByTime(100);
    c.leave();
    expect(c.isOpen).toBe(true); // still in grace period
    vi.advanceTimersByTime(300);
    expect(c.isOpen).toBe(false);
  });

  it('stays open when re-entered during the close grace period', () => {
    const c = new PeekController({ openDelay: 100, closeDelay: 300 });
    c.enter();
    vi.advanceTimersByTime(100);
    c.leave();
    vi.advanceTimersByTime(200); // within grace
    c.enter();
    vi.advanceTimersByTime(300); // past the original close time
    expect(c.isOpen).toBe(true);
  });

  it('closeNow() closes immediately and cancels pending timers', () => {
    const c = new PeekController({ openDelay: 100, closeDelay: 300 });
    c.enter();
    vi.advanceTimersByTime(100);
    c.closeNow();
    expect(c.isOpen).toBe(false);
    vi.advanceTimersByTime(1000); // a stray late timer must not reopen
    expect(c.isOpen).toBe(false);
  });

  it('fires onChange only on actual transitions', () => {
    const onChange = vi.fn();
    const c = new PeekController({ openDelay: 100, closeDelay: 300, onChange });
    c.enter();
    c.enter(); // duplicate enter does not cause an extra transition
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    c.closeNow();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('dispose() cancels a pending open so onChange never fires', () => {
    const onChange = vi.fn();
    const c = new PeekController({ openDelay: 100, closeDelay: 300, onChange });
    c.enter();
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/peekController.test.ts`
Expected: FAIL — `Failed to resolve import "src/renderer/lib/peekController"` (file does not exist yet).

- [ ] **Step 3: Implement `PeekController`**

Create `src/shared/peekController.ts`:

```ts
// Pure peek-timing state machine with no React or DOM dependencies, so it can be
// unit-tested in vitest's node environment with fake timers. The React side
// (hooks/usePeek.ts) wires mouseenter/mouseleave and Esc to these methods.
export interface PeekControllerOpts {
  openDelay?: number; // ms before enter() actually opens (default 150)
  closeDelay?: number; // ms grace period after leave() before closing (default 350)
  onChange?: (open: boolean) => void;
}

export class PeekController {
  private open = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly openDelay: number;
  private readonly closeDelay: number;
  private readonly onChange?: (open: boolean) => void;

  constructor(opts: PeekControllerOpts = {}) {
    this.openDelay = opts.openDelay ?? 150;
    this.closeDelay = opts.closeDelay ?? 350;
    this.onChange = opts.onChange;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Pointer entered the trigger or the content: keep open / schedule open. */
  enter(): void {
    this.clearClose();
    if (this.open || this.openTimer != null) return;
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.setOpen(true);
    }, this.openDelay);
  }

  /** Pointer left the trigger or the content: schedule a grace-period close. */
  leave(): void {
    this.clearOpen();
    if (!this.open || this.closeTimer != null) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.setOpen(false);
    }, this.closeDelay);
  }

  /** Close immediately (Esc, click-select). Cancels every pending timer. */
  closeNow(): void {
    this.clearOpen();
    this.clearClose();
    this.setOpen(false);
  }

  /** Tear down: cancel timers so no late callback fires after unmount. */
  dispose(): void {
    this.clearOpen();
    this.clearClose();
  }

  private setOpen(v: boolean): void {
    if (this.open === v) return;
    this.open = v;
    this.onChange?.(v);
  }

  private clearOpen(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private clearClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/peekController.test.ts`
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck`
Expected: no errors. (The new file compiles; nothing imports it yet.)

---

## Task 2: `usePeek` React hook

**Files:**
- Create: `src/renderer/hooks/usePeek.ts`

**Interfaces:**
- Consumes: `PeekController` from `src/shared/peekController.ts` (Task 1).
- Produces: `export function usePeek(opts?: { openDelay?: number; closeDelay?: number }): { open: boolean; triggerProps: { onMouseEnter: () => void; onMouseLeave: () => void }; contentProps: { onMouseEnter: () => void; onMouseLeave: () => void }; close: () => void }`. `close()` closes immediately. The same `triggerProps`/`contentProps` shape is consumed by `Peek` (Task 3) and the toggle button (Task 4).

Note: there is no React rendering test harness (no jsdom / @testing-library) in this repo, so this hook is verified by typecheck + the fact that all timing logic is covered by Task 1's unit tests, plus the end-to-end manual check in Task 7.

- [ ] **Step 1: Implement the hook**

Create `src/renderer/hooks/usePeek.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { PeekController } from '../../shared/peekController';

interface HoverProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export interface UsePeekResult {
  open: boolean;
  triggerProps: HoverProps;
  contentProps: HoverProps;
  close: () => void;
}

// Adapts the pure PeekController to React: mouse events on the toggle button
// (triggerProps) and on the floating panel (contentProps) both drive the same
// controller, so moving the pointer from the toggle into the panel does not snap
// the panel shut (the close-delay grace period covers the transit). Esc closes.
export function usePeek(opts: { openDelay?: number; closeDelay?: number } = {}): UsePeekResult {
  const [open, setOpen] = useState(false);
  const ctrlRef = useRef<PeekController | null>(null);
  if (ctrlRef.current === null) {
    ctrlRef.current = new PeekController({
      openDelay: opts.openDelay,
      closeDelay: opts.closeDelay,
      onChange: setOpen, // setState identity is stable for the controller's lifetime
    });
  }

  // Cancel any pending timer on unmount.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    return () => ctrl?.dispose();
  }, []);

  // Esc closes the peek while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ctrlRef.current?.closeNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const triggerProps: HoverProps = {
    onMouseEnter: () => ctrlRef.current?.enter(),
    onMouseLeave: () => ctrlRef.current?.leave(),
  };
  const contentProps: HoverProps = {
    onMouseEnter: () => ctrlRef.current?.enter(),
    onMouseLeave: () => ctrlRef.current?.leave(),
  };
  const close = useCallback(() => ctrlRef.current?.closeNow(), []);

  return { open, triggerProps, contentProps, close };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Checkpoint**

The hook is not imported anywhere yet; typecheck passing is the gate. (Behavior is exercised in Task 7.)

---

## Task 3: `Peek` component + styles

**Files:**
- Create: `src/renderer/components/Peek.tsx`
- Modify: `src/renderer/styles.css` (append `.peek` rules)

**Interfaces:**
- Consumes: `usePeek`'s `contentProps` shape `{ onMouseEnter: () => void; onMouseLeave: () => void }`.
- Produces: `export function Peek(props: { open: boolean; side: 'left' | 'right'; anchorRef: React.RefObject<HTMLElement>; contentProps: { onMouseEnter: () => void; onMouseLeave: () => void }; closeOnClick?: boolean; onClose?: () => void; children: React.ReactNode })`. Renders `null` when `!open`. Otherwise portals a `.peek` div to `document.body`, pinned to `left: 0` or `right: 0`, top = the anchor button's bottom edge, height = the rest of the viewport. The content's own class (`.sidebar` / `.help-area`) determines the width — `Peek` itself imposes no width.

- [ ] **Step 1: Implement `Peek`**

Create `src/renderer/components/Peek.tsx`:

```tsx
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PeekProps {
  open: boolean;
  side: 'left' | 'right';
  anchorRef: React.RefObject<HTMLElement>; // the toggle button — peek sits below it
  contentProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  closeOnClick?: boolean; // sidebar peek: click dismisses; help peek: stays open
  onClose?: () => void;
  children: ReactNode;
}

// Floating overlay for a collapsed panel. position: fixed, portalled to body so
// it floats above the terminal without pushing it (the terminal keeps full
// width). Width comes from the child's own class (.sidebar / .help-area); the
// peek just positions and shadows. Top tracks the toggle button's bottom edge so
// it always sits just under the header.
export function Peek(props: PeekProps) {
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!props.open) {
      setTop(null);
      return;
    }
    const measure = () => {
      const r = props.anchorRef.current?.getBoundingClientRect();
      if (r) setTop(r.bottom);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [props.open, props.anchorRef]);

  if (!props.open || top == null) return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    top: `${top}px`,
    height: `calc(100% - ${top}px)`,
    ...(props.side === 'left' ? { left: 0 } : { right: 0 }),
  };

  return createPortal(
    <div
      className={'peek' + (props.side === 'left' ? ' peek-left' : ' peek-right')}
      style={style}
      onMouseEnter={props.contentProps.onMouseEnter}
      onMouseLeave={props.contentProps.onMouseLeave}
      onClick={props.closeOnClick ? props.onClose : undefined}
    >
      {props.children}
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Add the `.peek` styles**

Append to `src/renderer/styles.css`:

```css
/* Floating "peek" overlay for a collapsed side panel. Portalled to body,
   position: fixed; width is dictated by the child (.sidebar / .help-area). */
.peek {
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.peek.peek-left { border-right: 1px solid #ddd; }
.peek.peek-right { border-left: 1px solid #ddd; }
/* The docked panels are stretched by the flex row; inside the fixed peek they
   need an explicit height so their own overflow-y scrolling works. */
.peek > * { height: 100%; }
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Checkpoint**

`Peek` is not rendered yet; typecheck passing is the gate. Visual check happens in Task 7.

---

## Task 4: `PanelToggle` component + styles

**Files:**
- Create: `src/renderer/components/PanelToggle.tsx`
- Modify: `src/renderer/styles.css` (append `.panel-toggle` rules)

**Interfaces:**
- Consumes: `usePeek` (Task 2), `Peek` (Task 3).
- Produces: `export function PanelToggle(props: { side: 'left' | 'right'; collapsed: boolean; icon: string; title: string; onToggle: () => void; peekContent: React.ReactNode; closePeekOnClick?: boolean })`. Renders a `.panel-toggle` button showing `‹`/`›` when expanded (click → `onToggle`, i.e. collapse) or `icon` when collapsed (click → `onToggle`, i.e. expand; hover → open the `Peek`).

- [ ] **Step 1: Implement `PanelToggle`**

Create `src/renderer/components/PanelToggle.tsx`:

```tsx
import { useRef, type ReactNode } from 'react';
import { usePeek } from '../hooks/usePeek';
import { Peek } from './Peek';

interface PanelToggleProps {
  side: 'left' | 'right';
  collapsed: boolean;
  icon: string; // glyph shown when collapsed
  title: string; // used in the tooltip
  onToggle: () => void; // expand when collapsed, collapse when expanded
  peekContent: ReactNode; // floated when collapsed + hovered
  closePeekOnClick?: boolean; // sidebar: true; help: false
}

// Permanent header control for one side panel. Expanded -> chevron (click to
// collapse). Collapsed -> panel icon (click to re-dock, hover to peek).
export function PanelToggle(props: PanelToggleProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const peek = usePeek();
  const chevron = props.side === 'left' ? '‹' : '›';

  return (
    <>
      <button
        ref={btnRef}
        className={'panel-toggle ' + (props.side === 'left' ? 'pt-left' : 'pt-right')}
        title={props.collapsed ? `展开${props.title}` : `收起${props.title}`}
        onClick={() => {
          peek.close(); // a click is an explicit toggle: dismiss any open peek
          props.onToggle();
        }}
        {...(props.collapsed ? peek.triggerProps : {})}
      >
        {props.collapsed ? props.icon : chevron}
      </button>
      {props.collapsed && (
        <Peek
          open={peek.open}
          side={props.side}
          anchorRef={btnRef}
          contentProps={peek.contentProps}
          closeOnClick={props.closePeekOnClick}
          onClose={peek.close}
        >
          {props.peekContent}
        </Peek>
      )}
    </>
  );
}
```

- [ ] **Step 2: Add the `.panel-toggle` styles**

Append to `src/renderer/styles.css`:

```css
/* Collapse/expand + hover-peek toggle, one at each end of the term-header. */
.panel-toggle {
  flex: 0 0 auto;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; line-height: 1; padding: 0;
  color: #ccc; background: transparent;
  border: 1px solid transparent; border-radius: 6px; cursor: pointer;
}
.panel-toggle:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Checkpoint**

`PanelToggle` is not used yet; typecheck passing is the gate.

---

## Task 5: `Sidebar` `floating` prop

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

**Interfaces:**
- Produces: `Sidebar` gains an optional `floating?: boolean` prop. When truthy, the `<div className="sidebar-resizer">` is omitted (the peek is not resizable). All existing props and behavior are unchanged.

- [ ] **Step 1: Add the `floating` prop and gate the resizer**

In `src/renderer/components/Sidebar.tsx`, change the props type to add `floating?: boolean`:

Find:
```tsx
export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onNew: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
```
Replace with:
```tsx
export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onNew: () => void;
  onExport: () => void;
  onImport: () => void;
  floating?: boolean;
}) {
```

Then gate the resizer. Find:
```tsx
      <div className="sidebar-io">
        <button className="io-btn" onClick={props.onExport} title="导出全部工具为 JSON">⤓ 导出</button>
        <button className="io-btn" onClick={props.onImport} title="从 JSON 导入工具">⤒ 导入</button>
      </div>
      <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />
    </nav>
```
Replace with:
```tsx
      <div className="sidebar-io">
        <button className="io-btn" onClick={props.onExport} title="导出全部工具为 JSON">⤓ 导出</button>
        <button className="io-btn" onClick={props.onImport} title="从 JSON 导入工具">⤒ 导入</button>
      </div>
      {!props.floating && <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />}
    </nav>
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Checkpoint**

`floating` defaults to undefined (falsy) so docked behavior is unchanged. App will pass `floating` in Task 6.

---

## Task 6: Wire collapse state + toggles into `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `PanelToggle` (Task 4), `Sidebar` with `floating` (Task 5).
- Produces: the app now has two persisted collapse states and two `PanelToggle` slots in the term-header; docked panels render only when expanded.

- [ ] **Step 1: Add the import**

In `src/renderer/App.tsx`, add the `PanelToggle` import alongside the other component imports.

Find:
```tsx
import { HoverTip } from './components/HoverTip';
```
Replace with:
```tsx
import { HoverTip } from './components/HoverTip';
import { PanelToggle } from './components/PanelToggle';
```

- [ ] **Step 2: Add the persisted collapse states**

Inside `App()`, after the `liveCwd` state block (the `const [liveCwd, setLiveCwd] = useState<string | null>(null);` line) and before the `useEffect` that polls cwd, add the collapse state + persistence:

Find:
```tsx
  const [liveCwd, setLiveCwd] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);
```
Replace with:
```tsx
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('gui-anything:sidebar-collapsed') === '1',
  );
  const [helpCollapsed, setHelpCollapsed] = useState<boolean>(
    () => localStorage.getItem('gui-anything:help-collapsed') === '1',
  );

  useEffect(() => {
    localStorage.setItem('gui-anything:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('gui-anything:help-collapsed', helpCollapsed ? '1' : '0');
  }, [helpCollapsed]);

  useEffect(() => {
    if (!activeId && tools.length > 0) setActiveId(tools[0].meta.id);
  }, [tools, activeId]);
```

- [ ] **Step 3: Build the shared panel content elements and rewire the layout**

Replace the entire `return ( ... )` JSX (the `<div className="app">…</div>` block at the end of `App`) with the version below. It builds `sidebarContent` and `helpContent` once each, renders the docked panel only when expanded, and adds the two `PanelToggle` slots in the term-header.

Find (the whole return block):
```tsx
  return (
    <div className="app">
      <Sidebar
        tools={tools}
        activeId={activeId}
        onSelect={setActiveId}
        onReorder={reorderTools}
        onNew={createTool}
        onExport={exportTools}
        onImport={importTools}
      />
      <section className="terminal-area">
        <div className="term-header">
          <span className="term-cwd">
            <span className="term-cwd-icon">📂</span>
            <HoverTip className="term-cwd-path" text={liveCwd ?? active?.meta.cwd ?? '~'}>
              {liveCwd ?? active?.meta.cwd ?? '~'}
            </HoverTip>
          </span>
          <div className="term-actions">
            <QuickCommands activeTool={active} />
            {active && (
              <button
                className="term-restart"
                title="重启终端"
                onClick={() => {
                  termRegistry.get(active.meta.id)?.reset();
                  window.api.pty.restart(active.meta.id, {
                    cwd: active.meta.cwd,
                    shell: active.meta.shell,
                    env: active.meta.env,
                    tmux: active.meta.tmux,
                    initCommands: active.meta.initCommands,
                  });
                }}
              >
                ↻ 重启终端
              </button>
            )}
          </div>
        </div>
        <div className="term-pane-wrap">
          {activeId ? (
            <TerminalPane tools={tools} activeId={activeId} />
          ) : (
            <div className="placeholder">选择一个工具</div>
          )}
        </div>
      </section>
      <section className="help-area">
        {active && editingId === active.meta.id ? (
          <EditorPane tool={active} onDone={() => setEditingId(null)} />
        ) : active ? (
          <>
            <div className="help-toolbar">
              <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>✕ 删除</button>
              <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>⤓ 导出</button>
              {active.meta.useRemote && (
                <button title="重新读取远程内容" onClick={() => window.api.refreshMd()}>⟳ 重新读取</button>
              )}
              <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
            </div>
            <HelpPane
              tool={active}
              activeToolId={active.meta.id}
              markdown={
                active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown
              }
            />
          </>
        ) : (
          <div className="placeholder">无选中工具</div>
        )}
      </section>
      {errors.length > 0 && <Notifications errors={errors} />}
    </div>
  );
```
Replace with:
```tsx
  // Each panel's element is built once and used in exactly one place: docked
  // when expanded, or floated inside the Peek when collapsed. Same component =>
  // one source of truth for the tool list and the docs.
  const sidebarContent = (
    <Sidebar
      tools={tools}
      activeId={activeId}
      onSelect={setActiveId}
      onReorder={reorderTools}
      onNew={createTool}
      onExport={exportTools}
      onImport={importTools}
      floating={sidebarCollapsed}
    />
  );
  const helpContent = (
    <div className="help-area">
      {active && editingId === active.meta.id ? (
        <EditorPane tool={active} onDone={() => setEditingId(null)} />
      ) : active ? (
        <>
          <div className="help-toolbar">
            <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>✕ 删除</button>
            <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>⤓ 导出</button>
            {active.meta.useRemote && (
              <button title="重新读取远程内容" onClick={() => window.api.refreshMd()}>⟳ 重新读取</button>
            )}
            <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
          </div>
          <HelpPane
            tool={active}
            activeToolId={active.meta.id}
            markdown={
              active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown
            }
          />
        </>
      ) : (
        <div className="placeholder">无选中工具</div>
      )}
    </div>
  );

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      <section className="terminal-area">
        <div className="term-header">
          <PanelToggle
            side="left"
            collapsed={sidebarCollapsed}
            icon="☰"
            title="工具列表"
            onToggle={() => setSidebarCollapsed((v) => !v)}
            peekContent={sidebarContent}
            closePeekOnClick
          />
          <span className="term-cwd">
            <span className="term-cwd-icon">📂</span>
            <HoverTip className="term-cwd-path" text={liveCwd ?? active?.meta.cwd ?? '~'}>
              {liveCwd ?? active?.meta.cwd ?? '~'}
            </HoverTip>
          </span>
          <div className="term-actions">
            <QuickCommands activeTool={active} />
            {active && (
              <button
                className="term-restart"
                title="重启终端"
                onClick={() => {
                  termRegistry.get(active.meta.id)?.reset();
                  window.api.pty.restart(active.meta.id, {
                    cwd: active.meta.cwd,
                    shell: active.meta.shell,
                    env: active.meta.env,
                    tmux: active.meta.tmux,
                    initCommands: active.meta.initCommands,
                  });
                }}
              >
                ↻ 重启终端
              </button>
            )}
          </div>
          <PanelToggle
            side="right"
            collapsed={helpCollapsed}
            icon="📖"
            title="工具文档"
            onToggle={() => setHelpCollapsed((v) => !v)}
            peekContent={helpContent}
          />
        </div>
        <div className="term-pane-wrap">
          {activeId ? (
            <TerminalPane tools={tools} activeId={activeId} />
          ) : (
            <div className="placeholder">选择一个工具</div>
          )}
        </div>
      </section>
      {!helpCollapsed && helpContent}
      {errors.length > 0 && <Notifications errors={errors} />}
    </div>
  );
```

- [ ] **Step 4: Add a small gap in the header so the new toggles don't crowd the cwd**

The existing `.term-header` already lays out children with `justify-content: space-between`; the two `.panel-toggle` buttons are `flex: 0 0 auto` and the `.term-cwd` is `flex: 1 1 auto`, so the layout is correct with no CSS change required. Verify by reading `src/renderer/styles.css` lines around `.term-header` — confirm `.term-cwd` has `flex: 1 1 auto` (it does). No edit needed.

- [ ] **Step 5: Verify it compiles and existing tests still pass**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run test`
Expected: all existing tests still pass plus the 7 new `peekController` tests.

- [ ] **Step 6: Checkpoint**

The app is now functionally complete. Proceed to Task 7 for end-to-end manual verification.

---

## Task 7: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run: `npm run dev`
Expected: the Electron window opens with the 3-column layout. The term-header now shows `‹` at the far left and `›` at the far right (both panels start expanded).

- [ ] **Step 2: Collapse the sidebar**

Click the `‹` chevron at the left of the term-header.
Expected: the sidebar disappears, the terminal widens to fill the space and reflows (text re-wraps; the existing ResizeObserver refits it). The `‹` becomes `☰`.

- [ ] **Step 3: Peek the tool list**

Hover the `☰` icon.
Expected: after ~150 ms a floating tool list appears pinned to the left edge, overlaying the terminal (the terminal is not pushed). Move the pointer from the icon into the floating list — it stays open (grace period). Run the pointer off the list — after ~350 ms it closes. Press nothing.

- [ ] **Step 4: Select a tool from the peek**

Hover `☰` to open the peek, then click a different tool in the list.
Expected: the peek closes immediately and the terminal switches to the selected tool (its cwd/prompt appears).

- [ ] **Step 5: Re-expand the sidebar**

Click the `☰` icon.
Expected: the sidebar re-docks at its previous width; the terminal narrows and refits. The icon becomes `‹` again.

- [ ] **Step 6: Repeat for the help panel**

Click the `›` chevron at the right → help disappears, terminal widens, `›` becomes `📖`. Hover `📖` → the docs float in pinned to the right. Click a ` ```buttons ` command inside the peek → the command runs in the terminal and **the peek stays open** (so you can run another). Move the pointer off → closes after the grace delay. Esc closes it immediately. Click `📖` → re-docks.

- [ ] **Step 7: Both collapsed**

Collapse both sides. The terminal takes the full width minus the two icon buttons. Hover each icon in turn — each peek appears on its side. Both peeks never need to coexist (single pointer), and during the close-grace transition a brief overlap is acceptable.

- [ ] **Step 8: Persistence**

With (say) the sidebar collapsed and the help expanded, quit the app (Cmd+Q) and relaunch (`npm run dev`).
Expected: the sidebar is collapsed and the help is expanded on startup — the state was restored from localStorage.

- [ ] **Step 9: No regressions**

While a panel is expanded, drag the sidebar resizer — resizing still works and the new width is used the next time the sidebar is collapsed+peeked (the `Sidebar` reads it from the same `gui-anything:sidebar-width` key). Create a new tool (`+ 新建工具`), edit, delete, export/import — all still work.

- [ ] **Step 10: Final checkpoint**

If all steps pass, the feature is complete. Update the spec's status line in `docs/superpowers/specs/2026-07-01-collapsible-panels-design.md` from `Approved (design phase)` to `Implemented`.

---

## Self-Review

**1. Spec coverage** — checked each spec section against the tasks:
- Layout states (expanded / collapsed / collapsed+hover): Task 6 (wiring) + Task 7 (verify). ✓
- Toggle always in header; chevron expanded / icon collapsed; click toggles; hover peeks: Task 4 + Task 6. ✓
- Peek close = grace-delay leave + Esc; sidebar-select closes; help stays open on command: Task 1 (timing) + Task 2 (Esc) + Task 4 (`closePeekOnClick`) + Task 6 (sidebar `closePeekOnClick`, help omits it). ✓
- Peek is a portal overlay, anchored under the toggle, full height, side-pinned, terminal not pushed: Task 3. ✓
- Each side independent; freed width to terminal: Task 6 (conditional docked render → flex gives width to `.terminal-area`). ✓
- Persistence of both collapse states; default both expanded: Task 6 Step 2. ✓
- Single source of truth (same component docked vs. floated): Task 6 Step 3 (`sidebarContent` / `helpContent` built once). ✓
- Sidebar resizer hidden in peek: Task 5. ✓
- No IPC/main/preload changes: confirmed — only `src/renderer/**` and `tests/**` touched. ✓
- Testing — unit (PeekController) + manual matrix: Task 1 + Task 7. ✓

**2. Placeholder scan** — no TBD/TODO/"add error handling"/"similar to Task N". Every code step contains the full code; every command has expected output. ✓

**3. Type consistency** —
- `PeekController` constructor opts `{ openDelay?, closeDelay?, onChange? }` and methods `isOpen/enter/leave/closeNow/dispose` are identical in Task 1 (impl), Task 1 (tests), and Task 2 (consumer). ✓
- `usePeek` returns `{ open, triggerProps, contentProps, close }`; `triggerProps`/`contentProps` are `{ onMouseEnter, onMouseLeave }`. `Peek` (Task 3) consumes exactly `contentProps: { onMouseEnter, onMouseLeave }` and the toggle button spreads `triggerProps`. `PanelToggle` (Task 4) consumes `usePeek()` and passes `contentProps`/`close` to `Peek`. ✓
- `Peek` props `{ open, side, anchorRef, contentProps, closeOnClick?, onClose?, children }` match what `PanelToggle` passes. ✓
- `PanelToggle` props `{ side, collapsed, icon, title, onToggle, peekContent, closePeekOnClick? }` match the two call sites in Task 6 (sidebar passes `closePeekOnClick`; help omits it → undefined → falsy). ✓
- `Sidebar` adds `floating?: boolean`; Task 6 passes `floating={sidebarCollapsed}`. ✓

No issues found.
