import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateState } from '../hooks/useUpdateState';

// Sidebar-bottom update checker: a persistent "检查更新" button plus a result
// line beneath it. Clicking the button triggers a manual check.
//   available -> "✦ 有新版本" badge (click opens popover with notes + 去下载)
//   upToDate  -> "已是最新版"
//   error     -> "检查失败"
//   idle/checking -> (no result line)
//
// Auto check on startup stays silent (wired in index.ts); it just pre-populates
// the result line if a new version is already known.

export function UpdateChecker() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false); // available-version popover open?
  const [checking, setChecking] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);

  // Reflect the "checking" phase in the button label: main sets status=checking
  // only for MANUAL checks (auto checks never broadcast checking), so we can map
  // status->checking faithfully. Reset checking=false once a terminal state
  // (available/upToDate/error) or idle arrives.
  useEffect(() => {
    if (state.status === 'checking') setChecking(true);
    else setChecking(false);
  }, [state.status]);

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await window.api.update.check();
    } finally {
      // status broadcast will flip this off via the effect above; this is a
      // safety net in case the broadcast races.
      setChecking(false);
    }
  };

  return (
    <div className="update-checker">
      <button className="uc-check-btn" onClick={runCheck} disabled={checking}>
        {checking ? '检查中…' : '检查更新'}
      </button>
      {state.status === 'available' && (
        <button
          ref={badgeRef}
          className="uc-badge"
          onClick={() => setOpen((v) => !v)}
          title={`新版本 v${state.version}`}
        >
          ✦ 有新版本
        </button>
      )}
      {state.status === 'upToDate' && <div className="uc-uptodate">已是最新版</div>}
      {state.status === 'error' && (
        <div className="uc-error" title={state.error}>
          检查失败
        </div>
      )}

      {open &&
        state.status === 'available' &&
        badgeRef.current &&
        createPortal(
          <div
            className="update-popover"
            style={popoverPos(badgeRef.current)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="up-title">✦ 新版本 v{state.version}</div>
            {state.notes && <div className="up-notes">{state.notes}</div>}
            <div className="up-actions">
              <button
                className="up-primary"
                onClick={() => void window.api.shell.openExternal(state.url)}
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

// Position the portal popover just above the badge, aligned to the badge's left
// edge, clamped to the viewport.
function popoverPos(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 280));
  return { left: `${left}px`, top: `${Math.max(8, r.top - 8)}px`, transform: 'translate(0, -100%)' };
}
