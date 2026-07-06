import { useEffect, useRef, useState } from 'react';

// Quick-add (append mode): grab the clipboard (or let the user type), then
// append it as a new ```buttons fence to the end of the tool's help.md. Mirrors
// ParamPromptModal's structure (overlay + autofocus + Esc). Reuses existing
// modal/textarea CSS classes — no new styles.
export function QuickAddModal(props: {
  onSubmit: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const { onSubmit, onClose } = props;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedRef = useRef(false);

  // Prefill from the clipboard (async — it's the main-process clipboard over
  // IPC, since the sandboxed preload can't reach `clipboard` directly). Focus
  // immediately; once the prefilled content lands, select-all so typing replaces
  // it. Errors (clipboard unavailable) degrade to an empty field.
  useEffect(() => {
    const ta = taRef.current;
    ta?.focus();
    let cancelled = false;
    window.api.clipboard
      .readText()
      .then((text) => {
        if (!cancelled && text) setValue(text);
      })
      .catch(() => {
        /* clipboard unavailable — leave empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Select-all once, after the prefilled value first arrives.
  useEffect(() => {
    if (selectedRef.current || !value) return;
    selectedRef.current = true;
    taRef.current?.select();
  }, [value]);

  // Esc cancels (not while a submit is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const canSubmit = value.trim() !== '' && !busy;

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
          每行一条命令，将作为新的 <code>buttons</code> 块追加到文档末尾。
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
