import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Quick-add (append mode): the textarea starts as a ```buttons fence template
// (so the user can edit commands in place), and the whole input is appended to
// the tool's help.md verbatim as a markdown block — not force-wrapped. That
// means the user can change the fence type (```sh, ```bash), drop the fence for
// a heading/plain text, or paste arbitrary markdown. Clipboard content, when
// present, is spliced inside the fence and selected so typing replaces it;
// otherwise the cursor lands inside the empty fence. Mirrors ParamPromptModal's
// structure (overlay + autofocus + Esc). Reuses existing modal/textarea CSS
// classes — no new styles.

// Empty fence template. Index 11 (right after "```buttons\n") is the inside.
const BUTTONS_TEMPLATE = '```buttons\n\n```';
const FENCE_INSIDE_START = '```buttons\n'.length; // 11

// Whether the input has any real content to append. Strips an empty ```buttons
// fence (the starting template) so opening the modal and hitting "添加" without
// typing anything is a no-op; any other content (commands inside the fence,
// plain text/headings, a different fence type) counts as real.
const EMPTY_FENCE_RE = /```buttons\s*\n\s*\n```/;
function hasRealContent(v: string): boolean {
  return v.replace(EMPTY_FENCE_RE, '').trim() !== '';
}

export function QuickAddModal(props: {
  onSubmit: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const { onSubmit, onClose } = props;
  const [value, setValue] = useState(BUTTONS_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorPlacedRef = useRef(false);

  // Position the textarea selection once. No-op after the first successful
  // placement (cursorPlacedRef). Deferred via rAF so the DOM value (which may
  // have just changed via setValue) is committed before we select.
  const placeCursor = (start: number, end: number) => {
    if (cursorPlacedRef.current) return;
    cursorPlacedRef.current = true;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start, end);
    });
  };

  // Prefill from the clipboard (async — it's the main-process clipboard over
  // IPC, since the sandboxed preload can't reach `clipboard` directly). Focus
  // immediately. The field already shows the buttons fence template; if the
  // clipboard has content it gets spliced inside the fence and selected so
  // typing replaces it. If the clipboard is empty/unavailable the template
  // stays and the cursor lands inside the empty fence.
  useEffect(() => {
    const ta = taRef.current;
    ta?.focus();
    let cancelled = false;
    api.clipboard
      .readText()
      .then((text) => {
        if (cancelled) return;
        const trimmed = text.trim();
        if (trimmed) {
          // Splice clipboard inside the fence and select it for quick replace.
          const filled = '```buttons\n' + trimmed + '\n```';
          setValue(filled);
          placeCursor(FENCE_INSIDE_START, FENCE_INSIDE_START + trimmed.length);
        } else {
          placeCursor(FENCE_INSIDE_START, FENCE_INSIDE_START);
        }
      })
      .catch(() => {
        /* clipboard unavailable — keep the empty fence template */
        placeCursor(FENCE_INSIDE_START, FENCE_INSIDE_START);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc cancels (not while a submit is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const canSubmit = hasRealContent(value) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">快速添加命令</div>
        <div className="modal-hint">
          输入会作为 markdown 块原样追加到文档末尾。默认是 <code>```buttons</code> 围栏，可改为其它围栏类型或添加普通文本/标题。
        </div>
        <textarea
          ref={taRef}
          className="quick-editor-md"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // ⌘Enter / Ctrl+Enter submits; plain Enter stays a newline so users
            // can paste multi-line command lists.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={'git status\ngit pull\nmake build'}
        />
        {error && <div className="param-error">{error}</div>}
        <div className="modal-actions">
          <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? '添加中…' : '添加'}
          </button>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
