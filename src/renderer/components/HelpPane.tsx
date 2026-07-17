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

interface TocEntry {
  id: string;
  text: string;
}

// H2 数量达到此阈值才启用自动折叠 + TOC，避免短文档被折叠得支离破碎。
const COLLAPSE_THRESHOLD = 3;

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
  const [toc, setToc] = useState<TocEntry[]>([]);
  // 跟踪所有"已展开"的 section id —— 凡是展开的 chip 都高亮（非 scrollspy）。
  // 初始默认全部折叠，用户点击 summary 或 chip 后按需更新。
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Clear any showing tooltip when the rendered content changes.
    setTip(null);
  }, [html]);

  // 渲染后把 H2 分节自动包裹成 <details>，H2 数 >= 阈值才启用。
  // 序言（H1 及第一个 H2 之前的内容）保留在 details 外，不折叠。
  // 直接给每个 details 绑 toggle 监听（toggle 不冒泡，事件代理收不到，必须绑目标）。
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const h2s = Array.from(root.querySelectorAll('h2'));
    if (h2s.length < COLLAPSE_THRESHOLD) {
      setToc([]);
      setOpenIds(new Set());
      return;
    }
    const entries: TocEntry[] = [];
    const initialOpen = new Set<string>();
    const handlers: Array<{ el: HTMLDetailsElement; fn: () => void }> = [];
    // 初始化默认展开期间抑制闪动（仅 setAttribute 初始打开时为 true，之后翻 false）。
    let initializing = true;
    h2s.forEach((h2, i) => {
      const id = `sec-${i}`;
      const details = document.createElement('details');
      details.className = 'help-section';
      details.id = id;
      const summary = document.createElement('summary');
      summary.className = 'help-section-summary';
      // 把 h2 的子节点移入 summary（保留行内格式，不留空的 h2 外壳）
      while (h2.firstChild) summary.appendChild(h2.firstChild);
      details.appendChild(summary);
      // h2 之后、下一个 h2 之前的所有兄弟移入一个 body 包裹层（方便统一加 padding）
      const body = document.createElement('div');
      body.className = 'help-section-body';
      let next: Element | null = h2.nextSibling as Element | null;
      const collected: Node[] = [];
      while (next && next.nodeName !== 'H2') {
        collected.push(next);
        next = next.nextSibling as Element | null;
      }
      // 先占位再移动，避免在循环中修改 live 兄弟链表
      h2.parentNode!.insertBefore(details, h2);
      collected.forEach((node) => body.appendChild(node));
      details.appendChild(body);
      h2.remove();
      // 绑定 toggle：用户交互展开/折叠时同步 openIds（高亮）+ 新展开触发闪动。
      const fn = () => {
        if (initializing) return; // 初始化默认展开阶段不闪动
        setOpenIds((prev) => {
          const nxt = new Set(prev);
          if (details.open) {
            nxt.add(id);
            // 新展开：闪动动效（先移除再添加以重启动画），1.5s 后移除 class。
            details.classList.remove('help-section-flash');
            void details.offsetWidth;
            details.classList.add('help-section-flash');
            window.setTimeout(() => details.classList.remove('help-section-flash'), 1500);
          } else {
            nxt.delete(id);
          }
          return nxt;
        });
      };
      details.addEventListener('toggle', fn);
      // 默认全部展开：先绑监听再设 open（setAttribute 可能触发 toggle，被 flag 抑制）。
      details.setAttribute('open', '');
      initialOpen.add(id);
      handlers.push({ el: details, fn });
      entries.push({ id, text: summary.textContent ?? `第 ${i + 1} 节` });
    });
    initializing = false;
    setToc(entries);
    setOpenIds(initialOpen);
    return () => {
      handlers.forEach(({ el, fn }) => el.removeEventListener('toggle', fn));
      setToc([]);
      setOpenIds(new Set());
    };
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

  // 触发 section 闪动动效：先移除 class 重启动画，再添加，到时自动移除。
  // 点击已展开的 chip 时 open 无变化不触发 toggle，所以需要手动调用以再次闪动。
  const flashSection = (details: HTMLDetailsElement) => {
    details.classList.remove('help-section-flash');
    // 强制重排以重启动画（reflow trick）
    void (details as HTMLElement).offsetWidth;
    details.classList.add('help-section-flash');
    window.setTimeout(() => details.classList.remove('help-section-flash'), 1500);
  };
  // 点击 chip：展开对应 section 并滚动定位，并触发闪动（即使已展开也再闪一次）。
  const scrollToSection = (id: string) => {
    const root = ref.current;
    if (!root) return;
    const target = root.querySelector<HTMLDetailsElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashSection(target);
  };
  // 合并按钮：若存在折叠态则"全部展开"，否则"全部折叠"。
  const allOpen = toc.length > 0 && openIds.size >= toc.length;
  const toggleAll = () => {
    const root = ref.current;
    if (!root) return;
    const sections = root.querySelectorAll<HTMLDetailsElement>('details.help-section');
    const shouldOpen = !allOpen;
    sections.forEach((d) => {
      d.open = shouldOpen;
    });
  };

  return (
    <>
      {prompt.node}
      {toc.length >= COLLAPSE_THRESHOLD && (
        // TOC 栏固定在文档滚动区上方（.help-scroll 的前一个兄弟），不参与滚动。
        // 按钮和 chip 同属一个 flex 流，多行 wrap 一起换行（按钮不单独成行）。
        <div className="help-toc">
          <button type="button" className="help-toc-btn" onClick={toggleAll}>
            {allOpen ? '全部折叠' : '全部展开'}
          </button>
          {toc.map((t) => (
            <button
              key={t.id}
              type="button"
              data-toc-id={t.id}
              className={`help-toc-chip${openIds.has(t.id) ? ' active' : ''}`}
              title={t.text}
              onClick={() => scrollToSection(t.id)}
            >
              {t.text}
            </button>
          ))}
        </div>
      )}
      {/* .help-scroll 是文档独立滚动容器；TOC 在它上方固定。 */}
      <div className="help-scroll">
        <div className="help" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
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
