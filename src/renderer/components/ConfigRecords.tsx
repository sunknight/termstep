import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { CommitEntry } from '../../shared/types';

// 配置记录 modal：查看工具/全局的 git 提交历史与 diff。
// 每次保存且文件有变动时后端已自动提交，这里只读展示——无需手动快照操作。
//
// toolId 传入 → per-tool 模式（仅该工具 tools/<id>/ 的提交历史与 diff）；
// toolId 不传 → 全局模式（整个 configs 仓库的历史与 diff）。
export function ConfigRecords(props: { onClose: () => void; toolId?: string }) {
  const { onClose } = props;
  const scoped = !!props.toolId;
  const [log, setLog] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // 当前展开的 diff：'WORKING'（未提交变更）或某 commit hash。
  const [diffRev, setDiffRev] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);

  const fetchLog = useCallback(async () => {
    const lg = scoped
      ? await api.vcs.logTool(props.toolId!, 100)
      : await api.vcs.log(100);
    setLog(lg);
  }, [scoped, props.toolId]);

  useEffect(() => {
    fetchLog().finally(() => setLoading(false));
  }, [fetchLog]);

  // Esc 关闭（与其它 modal 一致）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 加载某条 diff（WORKING 或 commit hash）。
  const showDiff = useCallback(
    async (rev: string) => {
      setDiffLoading(true);
      setDiffRev(rev);
      try {
        const r = scoped
          ? await api.vcs.diffTool(props.toolId!, rev)
          : await api.vcs.diff(rev);
        setDiff(r.diff);
      } catch (e) {
        setDiff(String(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [scoped, props.toolId]
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal version-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{scoped ? '配置记录' : '全部配置记录'}</div>

        <div className="version-body">
          {loading ? (
            <div className="version-hint">加载中…</div>
          ) : (
            <>
              {/* diff 展示区（选中某项后显示） */}
              {diffRev && (
                <div className="version-diff-area">
                  <div className="version-diff-header">
                    <span>
                      {diffRev === 'WORKING'
                        ? '当前未提交变更'
                        : `提交 ${diffRev.slice(0, 7)}`}
                    </span>
                    <button className="version-diff-close" onClick={() => setDiffRev(null)}>
                      收起
                    </button>
                  </div>
                  {diffLoading ? (
                    <div className="version-hint">加载 diff…</div>
                  ) : diff.trim() ? (
                    <pre className="version-diff-pre">{diff}</pre>
                  ) : (
                    <div className="version-hint">无差异</div>
                  )}
                </div>
              )}

              {/* 提交列表 */}
              <div className="version-list-label">提交历史</div>
              <ul className="version-list">
                {/* 工作区未提交变更置顶 */}
                <li className={'version-item' + (diffRev === 'WORKING' ? ' active' : '')}>
                  <button className="version-item-main" onClick={() => showDiff('WORKING')}>
                    <span className="version-item-hash">工作区</span>
                    <span className="version-item-msg">当前未提交的变更</span>
                  </button>
                </li>
                {log.length === 0 && (
                  <li className="version-item version-item-empty">
                    暂无记录（每次保存配置时会自动产生一条）
                  </li>
                )}
                {log.map((c) => (
                  <li
                    key={c.hash}
                    className={'version-item' + (diffRev === c.hash ? ' active' : '')}
                  >
                    <button className="version-item-main" onClick={() => showDiff(c.hash)}>
                      <span className="version-item-hash">{c.shortHash}</span>
                      <span className="version-item-time">{formatTime(c.time)}</span>
                      <span className="version-item-msg">{c.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
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

// Unix 秒 → 本地可读时间（YYYY-MM-DD HH:MM）。
function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
