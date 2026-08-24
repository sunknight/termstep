import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { copyCommand } from '../lib/clipboardToast';

// 常用 buttons 语法速查——只列语法写法本身（不含示例命令），每条可复制。
// 完整参考在 设置 → 帮助文档。
const SNIPPETS: { desc: string; code: string }[] = [
  { desc: '显示名', code: '### label=显示名' },
  { desc: '编辑模式（粘贴不回车）', code: '### edit' },
  { desc: '色标', code: '### tag=标记' },
  { desc: '色标颜色', code: '### tag-color=red' },
  { desc: '多属性（; 分隔）', code: '### label=显示名; edit; tag=标记' },
  { desc: '注释行（不渲染）', code: '# 注释' },
  { desc: '纯文本行（不可点）', code: '// 说明' },
  { desc: '命令按钮围栏', code: '```buttons' },
  { desc: '整块只复制不执行', code: '```buttons copy' },
  { desc: '参数表单围栏', code: '```buttons-json' },
];

const ATTR_SUMMARY =
  '属性：label= · edit · tag= · tag-color=red|amber|green|blue；多个用 ; 分隔；值含 ;=" 时用双引号包裹';

/**
 * 语法速查弹层。fixed 定位——挂在 .md-subregion（overflow:hidden）内部，absolute
 * 会被裁剪，fixed 不受祖先 overflow 影响；打开瞬间按锚点按钮的视口位置右对齐。
 */
export function SyntaxHelp(props: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const r = props.anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 400;
    setPos({
      top: r.bottom + 6,
      left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)),
    });
  }, [props.anchorRef]);

  // 外点关闭 + ESC 关闭（capture + stopImmediatePropagation，不冒泡给其他监听）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || props.anchorRef.current?.contains(t)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        props.onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [props.anchorRef, props.onClose]);

  if (!pos) return null;
  return (
    <div
      className="syntax-help-pop"
      ref={popRef}
      style={pos}
      role="dialog"
      aria-label="buttons 语法速查"
    >
      <div className="syn-title">buttons 语法速查（完整参考：设置 → 帮助文档）</div>
      {SNIPPETS.map((s) => (
        <div className="syn-row" key={s.code}>
          <span className="syn-desc">{s.desc}</span>
          <code className="syn-code">{s.code}</code>
          <button type="button" className="syn-copy" onClick={() => void copyCommand(s.code)}>
            复制
          </button>
        </div>
      ))}
      <div className="syn-foot">{ATTR_SUMMARY}</div>
    </div>
  );
}
