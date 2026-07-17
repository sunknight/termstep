import { useEffect, useMemo, useRef, useState } from 'react';
import type { Tool } from '../../shared/types';
import { md } from '../lib/markdown';
import { runCommandChecked } from '../lib/runCommandChecked';
import { useParamPrompt } from '../lib/paramPrompt';
import { substituteParams } from '../../shared/buttonBlock';
import { api } from '../lib/api';
import { copyOnModifier } from '../lib/clipboardToast';
import { confirmDialog } from '../lib/dialog';

interface TipState {
  text: string;
  left: number;
  top: number;
  bottom: number;
  below: boolean;
}

export function HelpPane(props: {
  tool: Tool;
  activeToolId: string;
  markdown: string;
  isRemote?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastBtn = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const prompt = useParamPrompt();
  const isRemote = !!props.isRemote;
  // 已确认过的远程按钮集合（按命令文本去重）：同一命令首次点击弹确认，之后不再打扰。
  // 仅存在于组件内存——切换工具/刷新页面后重置，保证用户不会被永久静音。
  const confirmedRemoteCmds = useRef<Set<string>>(new Set());
  const html = useMemo(() => md.render(props.markdown, { isRemote } as any), [props.markdown, isRemote]);

  useEffect(() => {
    // Clear any showing tooltip when the rendered content changes.
    setTip(null);
  }, [html]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onClick = async (e: MouseEvent) => {
      // Command buttons: inject into the terminal (with a danger confirm).
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        // ⌘/Ctrl + 点击：复制命令到剪贴板，不输入终端。
        if (e.metaKey || e.ctrlKey) {
          void copyOnModifier(e, command);
          return;
        }
        const edit = btn.dataset['edit'] === '1';
        const paramsRaw = btn.dataset['params'];
        const opts = {
          cwd: props.tool.meta.cwd,
          shell: props.tool.meta.shell,
          env: props.tool.meta.env,
          tmux: props.tool.meta.tmux,
          initCommands: props.tool.meta.initCommands,
        };
        // 远程订阅的按钮：首次点击弹确认（不可信内容可能注入危险命令）。
        // 用户确认后记入集合，同一命令后续点击不再打扰。
        if (btn.dataset['remote'] === '1' && !confirmedRemoteCmds.current.has(command)) {
          const verb = edit ? '粘贴' : '执行';
          const ok = await confirmDialog(
            `此命令来自远程订阅，可能包含不可信内容：\n\n${command}\n\n确定要${verb}吗？`,
            '远程命令确认',
          );
          if (!ok) return;
          confirmedRemoteCmds.current.add(command);
        }
        if (paramsRaw) {
          // Parametrized button: open the form, then run the substituted command.
          let params;
          try {
            params = JSON.parse(paramsRaw);
          } catch {
            params = [];
          }
          prompt.open({ command, edit, params }, (values) => {
            if (!values) return;
            void runCommandChecked(props.activeToolId, substituteParams(command, values), edit, opts);
          });
          return;
        }
        void runCommandChecked(props.activeToolId, command, edit, opts);
        return;
      }
      // Markdown links: open http(s)/mailto in the system browser instead of
      // trying to navigate the renderer.
      const anchor = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
      if (anchor) {
        const href = anchor.getAttribute('href') ?? '';
        // 仅放行 http(s)/mailto，其余 scheme 一律阻止默认导航（防 javascript:/data: 等）。
        if (/^(https?:|mailto:)/i.test(href)) {
          e.preventDefault();
          void api.shell.openExternal(href);
        } else {
          e.preventDefault(); // 非 http(s)/mailto：阻止 WebView 导航，忽略点击
        }
      }
    };

    // Delegated hover: show a fixed-position tooltip with the full command for any
    // labeled button (those carrying data-tip). Instant, custom-styled, and not
    // clipped by the scrolling panel because it is position: fixed.
    const onOver = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLElement | null;
      if (btn === lastBtn.current) return; // same button -> no churn
      lastBtn.current = btn;
      const text = btn?.dataset['tip'];
      if (!btn || !text) {
        setTip(null);
        return;
      }
      const r = btn.getBoundingClientRect();
      setTip({ text, left: r.left + r.width / 2, top: r.top, bottom: r.bottom, below: r.top < 50 });
    };
    const onLeave = () => {
      lastBtn.current = null;
      setTip(null);
    };

    el.addEventListener('click', onClick);
    el.addEventListener('mouseover', onOver);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('mouseover', onOver);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [props.activeToolId, props.tool.meta]);

  return (
    <>
      {prompt.node}
      <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {tip && (
        <div
          className="cmd-tip"
          style={
            tip.below
              ? { left: `${tip.left}px`, top: `${tip.bottom + 6}px`, transform: 'translate(-50%, 0)' }
              : { left: `${tip.left}px`, top: `${tip.top - 6}px`, transform: 'translate(-50%, -100%)' }
          }
        >
          {tip.text}
        </div>
      )}
    </>
  );
}
