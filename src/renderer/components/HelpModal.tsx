import { useEffect, useMemo } from 'react';
import { md } from '../lib/markdown';
// Bundled at build time via Vite's ?raw suffix — the markdown source becomes a
// string. Lives at src/renderer/help.md so it's easy to edit outside the app.
import helpMarkdown from '../help.md?raw';

// Full-reference help modal. Renders the bundled help.md through the same `md`
// instance the help pane uses, so buttons/buttons-json fences render as real
// buttons (visually — no click handler is wired here, so they're display-only).
// Mirrors the QuickAddModal / ParamPromptModal scaffold (.modal-overlay + .modal)
// but wider (.help-modal) with a scrollable body for the long content.
export function HelpModal(props: { onClose: () => void }) {
  const { onClose } = props;
  const html = useMemo(() => md.render(helpMarkdown), []);

  // Esc closes (same pattern as the other modals).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">帮助</div>
        <div className="help-modal-body">
          <div className="help" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
