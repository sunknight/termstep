// 终端 private mode 残留复位。
//
// 场景：SSH/tmux 异常断开（锁屏被踢/网络断）时远程端没机会发送 DECRST，
// xterm.js 里鼠标追踪（?1000/1002/1003）等模式残留——此后点击/滚动被编码成
// `0;61;22M` 类转义序列直写 pty，本机 shell 回显成乱码。
//
// 复位方式：把一组 DECRST/复位序列写进 xterm.js 自己的 parser（term.write），
// **不写 pty**（shell 无感知）、**不清屏**（保留断开消息上下文）、不动
// `?2004` bracketed paste（zsh/zle 自管，外部关闭会破坏粘贴直到下一提示符）。
// 触发：pty:probe 轮询到「前台程序退出回到 shell」跳变时自动（静默），
// 或顶栏「修复终端」按钮手动。序列幂等，正常退出的程序（vim/less）重复无害。
import type { Terminal } from '@xterm/xterm';

// 备用屏退出是唯一有光标副作用的一组，不能无条件发（见 ALT_SCREEN_EXIT_SEQ）。
export const MODES_RESET_SEQ =
  '\x1b[?9l' + // X10 鼠标
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l' + // 鼠标追踪：点击/拖拽/任意事件
  '\x1b[?1005l\x1b[?1015l\x1b[?1006l' + // 鼠标编码：UTF-8 / urxvt / SGR
  '\x1b[?1004l' + // focus 丢失/获得上报
  '\x1b[?2026l' + // 同步输出（残留会冻结渲染）
  '\x1b[?25h' + // 光标可见
  '\x1b[?1l' + // 光标键退出 application 模式
  '\x1b>' + // 小键盘退出 application 模式
  '\x1b(B'; // G0 字符集 = US ASCII

// 备用屏三代退出（tmux 用 1049）。`?1049l` 在 xterm.js 里是 activateNormalBuffer
// + restoreCursor：光标恢复到「进入备用屏时保存的位置」。本会话从未进过备用屏时
// 该保存值是初始 (0,0)——无条件发送等于每次命令结束把光标拉到左上角，屏幕不清，
// 新输出与旧内容重叠。因此仅在确实残留在备用屏时补发；SSH 断开时 tmux 的 rmcup
// 没送到，但 attach 时的 `?1049h` 已保存过正确位置，退出恢复恰好回到原地。
export const ALT_SCREEN_EXIT_SEQ = '\x1b[?47l\x1b[?1047l\x1b[?1049l';

export function resetTerminalModes(term: Terminal): void {
  const seq =
    term.buffer.active.type === 'alternate'
      ? ALT_SCREEN_EXIT_SEQ + MODES_RESET_SEQ
      : MODES_RESET_SEQ;
  term.write(seq);
}
