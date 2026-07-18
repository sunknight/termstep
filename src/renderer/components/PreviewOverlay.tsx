import { useEffect, useMemo } from 'react';
import { md } from '../lib/markdown';
import { api } from '../lib/api';

// 「请打开预览」的请求（由 HelpPane 链接点击产生，App 消费）。
// App 收到后启动对应流程：web 直接 setPreview；doc 先 setPreview(loading) 再
// fetch_md_preview 再 setPreview(md/txt/error)。
export type PreviewRequest =
  | { type: 'web'; url: string; title: string }
  | { type: 'doc'; url: string; title: string; isTxt: boolean };

// 预览内容类型。一次只展示一种内容（单视图，非多 tab）。
//   web  → iframe 加载任意 http(s) 页面（拒嵌站点显示空白，靠工具栏常驻「在浏览器打开」兜底）
//   md   → 复用 markdown.ts 渲染（远程/本地文档统一）
//   txt  → <pre> 原样显示
//   loading / error 是内部过渡态，由 open 流程内部设置。
export type PreviewState =
  | { kind: 'web'; url: string; title: string }
  | { kind: 'md'; title: string; content: string }
  | { kind: 'txt'; title: string; content: string }
  | { kind: 'loading'; title: string }
  | { kind: 'error'; title: string; message: string };

// 弹层预览。复用现有 .modal-overlay / .modal 模式（同 z-index 300、Esc 关闭、点背景关闭）。
// 相比其他 modal 更宽更高（.preview-modal），适合沉浸式预览网页与文档。
// 工具栏极简：左侧标题，右侧动作（web 有「在浏览器打开」+ 关闭，文档仅关闭）。
export function PreviewOverlay(props: { state: PreviewState; onClose: () => void }) {
  const { state, onClose } = props;

  // md 内容预渲染（仅 md 态需要，txt/loading/error/web 不用）。
  const mdHtml = useMemo(
    () => (state.kind === 'md' ? md.render(state.content) : ''),
    [state],
  );

  // Esc 关闭（与其他 modal 一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-toolbar">
          <span className="preview-title" title={state.title}>
            {state.kind === 'web' ? '🔗' : state.kind === 'error' ? '⚠️' : '📄'} {state.title}
          </span>
          <div className="preview-actions">
            {state.kind === 'web' && (
              <button
                className="preview-ext"
                title="在默认浏览器打开"
                onClick={() => void api.shell.openExternal(state.url)}
              >
                ↗ 在浏览器打开
              </button>
            )}
            <button className="preview-close" title="关闭 (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="preview-body">
          {state.kind === 'web' && (
            <iframe
              className="preview-iframe"
              src={state.url}
              title={state.title}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
            />
          )}
          {state.kind === 'md' && (
            <div className="preview-scroll">
              <div className="help" dangerouslySetInnerHTML={{ __html: mdHtml }} />
            </div>
          )}
          {state.kind === 'txt' && (
            <pre className="preview-pre">{state.content}</pre>
          )}
          {state.kind === 'loading' && (
            <div className="preview-status">加载中…</div>
          )}
          {state.kind === 'error' && (
            <div className="preview-status preview-error">
              <div className="preview-error-icon">⚠️</div>
              <div className="preview-error-msg">{state.message}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
