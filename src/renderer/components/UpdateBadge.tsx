import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateState } from '../hooks/useUpdateState';
import type { UpdateState } from '../../shared/types';

// A transient, self-dismissing popover for manual-check feedback ("已是最新版本"
// / "检查失败…"). Shown for 3s after a manual check resolves to upToDate/error,
// then disappears. Distinct from the available-version popover (which stays open
// until the user acts on it).
const TRANSIENT_MS = 3000;

// Sidebar "✦ 有新版本" badge + popover. Rendered at the bottom of the sidebar,
// below the import/export buttons. Only the `available` state shows the badge;
// manual checks that resolve to upToDate/error pop a brief message.
export function UpdateBadge() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false); // available-version popover open?
  const [transient, setTransient] = useState<string | null>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  // Detect a manual check completing in upToDate/error and flash a transient
  // message. We key off the status changing INTO upToDate/error (the renderer
  // can't tell manual from auto directly, but auto checks never set these
  // states — see updater.checkForUpdates — so any upToDate/error here is manual).
  const prevStatus = useRef<UpdateState['status']>('idle');
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = state.status;
    if (state.status === prev) return;
    if (state.status === 'upToDate') {
      setTransient('当前已是最新版本');
      setOpen(false);
    } else if (state.status === 'error') {
      setTransient(state.error);
      setOpen(false);
    } else {
      setTransient(null);
    }
  }, [state]);

  useEffect(() => {
    if (transient === null) return;
    const t = window.setTimeout(() => setTransient(null), TRANSIENT_MS);
    return () => clearTimeout(t);
  }, [transient]);

  if (state.status !== 'available' && transient === null) return null;

  return (
    <>
      {state.status === 'available' && (
        <button
          ref={badgeRef}
          className="update-badge"
          onClick={() => setOpen((v) => !v)}
          title={`新版本 v${state.version}`}
        >
          ✦ 有新版本
        </button>
      )}

      {(open || transient !== null) &&
        badgeRef.current &&
        createPortal(
          <div
            className="update-popover"
            style={popoverPos(badgeRef.current)}
            onClick={(e) => e.stopPropagation()}
          >
            {transient !== null ? (
              <div className="up-transient">{transient}</div>
            ) : state.status === 'available' ? (
              <>
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
                <button className="up-recheck" onClick={() => void window.api.update.check()}>
                  再检查一次
                </button>
              </>
            ) : null}
          </div>,
          document.body
        )}
    </>
  );
}

// Position the portal popover just above the badge, aligned to the badge's left
// edge, clamped to the viewport.
function popoverPos(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 280));
  return { left: `${left}px`, top: `${Math.max(8, r.top - 8)}px`, transform: 'translate(0, -100%)' };
}
