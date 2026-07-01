import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeekController } from '../src/shared/peekController';

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
