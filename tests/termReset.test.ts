import { describe, expect, it, vi } from 'vitest';
import { MODES_RESET_SEQ, resetTerminalModes } from '../src/renderer/lib/termReset';

// 复位序列是「中断后输入异常」修复的核心：内容错一个字符就是回归。
// 重点：关掉全部鼠标模式（乱码根源）、退出备用屏；刻意排除 2004（zsh 自管）
// 与清屏/RIS（保留屏幕内容）。
describe('MODES_RESET_SEQ', () => {
  it('关闭全部鼠标追踪与编码模式', () => {
    for (const m of ['\x1b[?9l', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l',
      '\x1b[?1005l', '\x1b[?1015l', '\x1b[?1006l']) {
      expect(MODES_RESET_SEQ).toContain(m);
    }
  });

  it('退出备用屏三代与其它残留模式', () => {
    for (const m of ['\x1b[?47l', '\x1b[?1047l', '\x1b[?1049l', '\x1b[?1004l',
      '\x1b[?2026l', '\x1b[?25h', '\x1b[?1l', '\x1b>', '\x1b(B']) {
      expect(MODES_RESET_SEQ).toContain(m);
    }
  });

  it('不触碰 bracketed paste（zsh/zle 自管）', () => {
    expect(MODES_RESET_SEQ).not.toContain('\x1b[?2004');
  });

  it('不清屏、不做 RIS（保留屏幕内容）', () => {
    expect(MODES_RESET_SEQ).not.toContain('\x1bc');
    expect(MODES_RESET_SEQ).not.toContain('\x1b[2J');
    expect(MODES_RESET_SEQ).not.toContain('\x1b[3J');
  });
});

describe('resetTerminalModes', () => {
  it('把复位序列写入 xterm parser（不返回数据到 pty）', () => {
    const write = vi.fn();
    resetTerminalModes({ write } as never);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(MODES_RESET_SEQ);
  });
});
