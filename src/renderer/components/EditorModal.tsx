import { useEffect } from 'react';
import type { Tool } from '../../shared/types';
import { EditorPane } from './EditorPane';

export function EditorModal(props: {
  tool: Tool;
  onDone: () => void;
  existingGroups: string[];
}) {
  // 关闭弹窗时恢复 body 滚动（保险）
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Esc 关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onDone]);

  return (
    <div className="modal-overlay" onClick={props.onDone}>
      <div
        className="modal editor-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-modal-title"
      >
        <div className="modal-header">
          <span id="editor-modal-title">编辑工具：{props.tool.meta.name}</span>
          <button
            className="modal-close"
            onClick={props.onDone}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <EditorPane
            tool={props.tool}
            onDone={props.onDone}
            existingGroups={props.existingGroups}
          />
        </div>
      </div>
    </div>
  );
}
