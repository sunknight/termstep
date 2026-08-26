import type { Tool } from './types';

/**
 * 编辑器草稿快照：EditorPane 全部可编辑字段的扁平镜像（字符串/布尔形态，
 * 与表单 state 一一对应）。用于挂载时捕获初值、关闭前比对是否脏。
 *
 * 比较语义是保守的：按表单原文比较（不做 trim 归一）。输入过又删回原样的
 * 字段自然回到相等；加了空白的字段会判脏（保存时 trim 后可能与磁盘相同，
 * 多弹一次确认是安全方向的误报，可接受）。
 */
export interface EditorDraft {
  name: string;
  icon: string;
  cwd: string;
  rootDir: string;
  tmux: string;
  /** 每行一条的原文（join('\n')）。 */
  initCommands: string;
  mdUrl: string;
  /** 数字输入的文本态；空串 = 未设置。 */
  autoUpdate: string;
  group: string;
  layout: 'LR' | 'TB';
  terminalHidden: boolean;
  /** 工具形态：'web' = 网页型；'default' = 默认终端+文档（表单态，磁盘上缺省）。 */
  kind: 'default' | 'web';
  /** 网页型工具的 URL（表单原文；默认形态下也有值——切回网页态不丢输入）。 */
  webUrl: string;
  /** 本地 help.md 草稿。 */
  markdown: string;
  /** 生效源是否为远程（与 EditorPane 的 effective 计算一致：远程 tab 且 URL 非空）。 */
  useRemote: boolean;
}

/** 从磁盘上的 Tool 生成草稿初值快照（EditorPane 挂载时调用一次）。 */
export function draftFromTool(tool: Tool): EditorDraft {
  const m = tool.meta;
  return {
    name: m.name,
    icon: m.icon,
    cwd: m.cwd ?? '',
    rootDir: m.rootDir ?? '',
    tmux: m.tmux ?? '',
    initCommands: (m.initCommands ?? []).join('\n'),
    mdUrl: m.mdUrl ?? '',
    autoUpdate: m.autoUpdateMinutes?.toString() ?? '',
    group: m.group ?? '',
    layout: m.layout === 'TB' ? 'TB' : 'LR',
    terminalHidden: !!m.terminalHidden,
    kind: m.kind === 'web' ? 'web' : 'default',
    webUrl: m.webUrl ?? '',
    markdown: tool.helpMarkdown,
    // 与保存语义对齐：useRemote=true 但 URL 为空的脏数据在编辑器里 effective
    // 恒为本地（保存会写回 false），初值同样按 effective 折算，避免打开即误报脏。
    useRemote: !!m.useRemote && (m.mdUrl ?? '').trim().length > 0,
  };
}

/** 逐字段比较两份草稿，任一不同即脏。 */
export function isDraftDirty(a: EditorDraft, b: EditorDraft): boolean {
  const keys = Object.keys(a) as (keyof EditorDraft)[];
  return keys.some((k) => a[k] !== b[k]);
}
