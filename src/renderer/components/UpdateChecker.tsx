import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateState } from '../hooks/useUpdateState';
import { api } from '../lib/api';

// Sidebar-bottom update checker: a SINGLE persistent button whose label and
// behavior depend on the check state.
//   idle      -> "检查更新"   (click: trigger manual check)
//   checking  -> "检查中…"    (disabled)
//   available -> "✦ 有新版本" (click: toggle popover with notes + 去下载)
//   upToDate  -> "已是最新版" (click: trigger manual check — let user re-check)
//   error     -> "检查失败"   (click: trigger manual check — retry)
//
// Auto check on startup stays silent (wired in index.ts); it just relabels the
// button if a new version is already known.

export function UpdateChecker() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false); // available-version popover open?
  const [checking, setChecking] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Reflect the "checking" phase in the button label: main sets status=checking
  // only for MANUAL checks (auto checks never broadcast checking). Reset once a
  // terminal state (available/upToDate/error) or idle arrives.
  useEffect(() => {
    setChecking(state.status === 'checking');
  }, [state.status]);

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await api.update.check();
    } finally {
      // status broadcast will flip this off via the effect above; safety net in
      // case the broadcast races.
      setChecking(false);
    }
  };

  // Click behavior depends on the current state.
  const onClick = () => {
    if (state.status === 'available') {
      setOpen((v) => !v);
    } else {
      void runCheck();
    }
  };

  const label = checking
    ? '检查中…'
    : state.status === 'available'
      ? `✦ 有新版本`
      : state.status === 'upToDate'
        ? '已是最新版'
        : state.status === 'error'
          ? '检查失败'
          : '检查更新';

  return (
    <div className="update-checker">
      <button
        ref={btnRef}
        className={'uc-check-btn' + (state.status === 'available' ? ' uc-has-update' : '')}
        onClick={onClick}
        disabled={checking}
        title={
          state.status === 'available'
            ? `新版本 v${state.version}（点击查看）`
            : state.status === 'error'
              ? state.error
              : undefined
        }
      >
        {label}
      </button>

      {open &&
        state.status === 'available' &&
        btnRef.current &&
        createPortal(
          <div
            className="update-popover"
            style={popoverPos(btnRef.current)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="up-title">✦ 新版本 v{state.version}</div>
            {state.notes && <div className="up-notes">{state.notes}</div>}
            <div className="up-actions">
              <button
                className="up-primary"
                onClick={() => void api.shell.openExternal(state.url)}
              >
                去下载
              </button>
              <button className="up-secondary" onClick={() => setOpen(false)}>
                稍后再说
              </button>
            </div>
            <button className="up-recheck" onClick={runCheck} disabled={checking}>
              {checking ? '检查中…' : '再检查一次'}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

// Position the portal popover just above the button, aligned to the button's
// left edge, clamped to the viewport.
function popoverPos(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 280));
  return { left: `${left}px`, top: `${Math.max(8, r.top - 8)}px`, transform: 'translate(0, -100%)' };
}
