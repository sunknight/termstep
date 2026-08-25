import { describe, expect, it, vi } from 'vitest';
import {
  ALT_SCREEN_EXIT_SEQ,
  MODES_RESET_SEQ,
  resetTerminalModes,
} from '../src/renderer/lib/termReset';

// 复位序列是「中断后输入异常」修复的核心：内容错一个字符就是回归。
// 重点：关掉全部鼠标模式（乱码根源）、备用屏退出改为条件发送；刻意排除 2004
// （zsh 自管）与清屏/RIS（保留屏幕内容）。
describe('MODES_RESET_SEQ', () => {
  it('关闭全部鼠标追踪与编码模式', () => {
    for (const m of ['\x1b[?9l', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l',
      '\x1b[?1005l', '\x1b[?1015l', '\x1b[?1006l']) {
      expect(MODES_RESET_SEQ).toContain(m);
    }
  });

  it('复位其它残留模式', () => {
    for (const m of ['\x1b[?1004l', '\x1b[?2026l', '\x1b[?25h',
      '\x1b[?1l', '\x1b>', '\x1b(B']) {
      expect(MODES_RESET_SEQ).toContain(m);
    }
  });

  it('不含备用屏退出（?1049l 会 restoreCursor，普通命令后发送导致光标跳到左上角）',
    () => {
      // 无条件序列必须无光标副作用；备用屏退出只在残留时条件发送（见下）。
      expect(MODES_RESET_SEQ).not.toContain('\x1b[?47l');
      expect(MODES_RESET_SEQ).not.toContain('\x1b[?1047l');
      expect(MODES_RESET_SEQ).not.toContain('\x1b[?1049l');
    });

  it('不触碰 bracketed paste（zsh/zle 自管）', () => {
    expect(MODES_RESET_SEQ).not.toContain('\x1b[?2004');
  });

  it('不清屏、不做 RIS（保留屏幕内容）', () => {
    expect(MODES_RESET_SEQ).not.toContain('\x1bc');
    expect(MODES_RESET_SEQ).not.toContain('\x1b[2J');
    expect(MODES_RESET_SEQ).not.toContain('\x1b[3J');
    expect(ALT_SCREEN_EXIT_SEQ).not.toContain('\x1bc');
  });
});

describe('ALT_SCREEN_EXIT_SEQ', () => {
  it('包含备用屏三代退出', () => {
    for (const m of ['\x1b[?47l', '\x1b[?1047l', '\x1b[?1049l']) {
      expect(ALT_SCREEN_EXIT_SEQ).toContain(m);
    }
  });
});

describe('resetTerminalModes', () => {
  const makeTerm = (type: 'normal' | 'alternate') => {
    const write = vi.fn();
    const term = {
      write,
      buffer: { active: { type } },
    };
    return { term, write };
  };

  it('主屏（普通命令结束）：只写基础复位序列，不退备用屏、光标不动', () => {
    const { term, write } = makeTerm('normal');
    resetTerminalModes(term as never);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(MODES_RESET_SEQ);
  });

  it('残留备用屏（SSH 断开时 tmux 没发 rmcup）：先退出备用屏再复位', () => {
    const { term, write } = makeTerm('alternate');
    resetTerminalModes(term as never);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(ALT_SCREEN_EXIT_SEQ + MODES_RESET_SEQ);
  });
});
