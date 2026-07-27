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

  return (
    // 编辑内容易因误操作丢失，故遮罩不响应点击关闭、ESC 也不关闭；
    // 只能通过 × 关闭按钮 / 取消 / 保存 主动关闭。
    <div className="modal-overlay">
        <div
          className="modal editor-modal"
          role="dialog"
        aria-modal="true"
        aria-labelledby="editor-modal-title"
        tabIndex={-1}
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
