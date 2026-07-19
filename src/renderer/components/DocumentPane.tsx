import { useEffect, useMemo, useRef } from 'react';
import type { Tool } from '../../shared/types';
import { md } from '../lib/markdown';
import { api } from '../lib/api';
import { copyOnModifier } from '../lib/clipboardToast';
import { classifyLink, isTxtPath } from '../../shared/previewLink';
import type { PreviewRequest } from './PreviewOverlay';

// 预览弹层的标题：优先用链接可见文本；否则从 URL/路径取最后一段（文件名或 host）。
// 与 HelpPane 内的同名函数逻辑一致——本任务范围控制，未抽 lib。
function titleFor(href: string, text: string): string {
  if (text && text !== href) return text;
  // 取 path 最后一段；URL 取 pathname，本地路径取末段
  try {
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      const seg = u.pathname.split('/').filter(Boolean).pop();
      return seg || u.host;
    }
  } catch {
    /* 非 URL，走下面 */
  }
  const seg = href.split('/').filter(Boolean).pop();
  return seg || href;
}

// 文档型工具主面板：整屏渲染一份 markdown，无终端。
//   - 链接点击：与 HelpPane 一致，分类后走 onPreview / api.shell.openExternal。
//   - 按钮 .cmd-btn：仅 ⌘/Ctrl+点击复制命令到剪贴板；普通点击无动作（文档型不可执行）。
// 不复用 HelpPane 的 TOC / 折叠 / toolbar —— 纯阅读视图。
export function DocumentPane(props: {
  tool: Tool;
  isRemote: boolean;
  /** 父组件已决定渲染 help.md 还是 remoteMarkdown。 */
  markdown: string;
  /** 点链接时打开预览弹层。由 App 注入；DocumentPane 负责 href 分类后调对应分支。 */
  onPreview?: (req: PreviewRequest) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => md.render(props.markdown, { isRemote: props.isRemote } as any),
    [props.markdown, props.isRemote],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onClick = (e: MouseEvent) => {
      // 按钮：仅 ⌘/Ctrl+点击复制；普通点击不执行（文档型工具按钮不可执行）。
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        if (e.metaKey || e.ctrlKey) {
          void copyOnModifier(e, command);
        }
        return;
      }

      // 链接：与 HelpPane 完全一致——preventDefault + classifyLink 五分支。
      const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        const text = (anchor.textContent ?? '').trim() || href;
        e.preventDefault();
        const c = classifyLink(href, props.tool.meta.cwd);
        switch (c.kind) {
          case 'web':
            props.onPreview?.({ type: 'web', url: c.url, title: titleFor(c.url, text) });
            return;
          case 'remoteDoc':
            props.onPreview?.({ type: 'doc', url: c.url, title: titleFor(c.url, text), isTxt: isTxtPath(c.url) });
            return;
          case 'localDoc':
            props.onPreview?.({ type: 'doc', url: c.path, title: titleFor(c.path, text), isTxt: isTxtPath(c.path) });
            return;
          case 'mailto':
            void api.shell.openExternal(href);
            return;
          case 'unsupported':
          case 'blocked':
          default:
            return; // 已 preventDefault，忽略点击
        }
      }
    };

    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('click', onClick);
    };
  }, [props.tool.meta.cwd, props.onPreview]);

  return (
    <div className="document-pane">
      <div className="document-scroll help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
