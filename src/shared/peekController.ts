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
