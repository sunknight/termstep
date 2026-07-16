import { useEffect, useRef, useState } from 'react';
import { applyTheme, getThemeMode, type ThemeMode } from '../lib/theme';

// 侧栏底部的设置分区。一个「⚙ 设置」按钮（与「新建工具」同款居中文字按钮），点击
// 从按钮下方滑出一个与侧栏等宽的浮层面板（绝对定位，不占文档流、不撑高侧栏），
// 面板内列出：外观（浅 / 深分段选择器）、导入工具、导出全部、帮助文档。
// floating 态（侧栏折叠 peek 中）由 Sidebar 控制不渲染本组件。
export function SettingsSection(props: {
  onImport: () => void;
  onExport: () => void;
  onHelp: () => void;
  onVersions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const wrapRef = useRef<HTMLDivElement>(null);

  // 其它窗口切换主题时保持本组件选中态同步（storage 事件跨窗口）。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'termstep:theme') setMode(getThemeMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 展开时点击外部 / Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chooseMode = (m: ThemeMode) => {
    setMode(m);
    applyTheme(m);
    setOpen(false); // 切换主题后收起菜单
  };

  return (
    <div className="settings-section" ref={wrapRef}>
      <button
        className={'settings-toggle' + (open ? ' open' : '')}
        // 用 mousedown 而非 click：终端的 xterm 在隐藏 textarea 上持有焦点，
        // 从终端点击本按钮时，焦点转移会干扰 click 合成（第一次点击常被吞，只完成
        // 夺焦点、onClick 不触发，需点第二次）。mousedown 在焦点转移之前派发且稳定
        // 触发；preventDefault 阻止它把焦点移到按钮，避免抢占终端焦点的副作用。
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        title="设置"
      >
        设置
      </button>

      {/* 从按钮下方滑出的浮层面板：与侧栏等宽、绝对定位、不占文档流。 */}
      {open && (
        <div className="settings-panel">
          <div className="settings-group">
            <div className="settings-group-label">外观</div>
            <div className="theme-segments" role="radiogroup" aria-label="主题">
              <SegmentBtn
                active={mode === 'light'}
                onClick={() => chooseMode('light')}
                title="浅色"
                icon="☀"
                label="浅色"
              />
              <SegmentBtn
                active={mode === 'dark'}
                onClick={() => chooseMode('dark')}
                title="深色"
                icon="🌙"
                label="深色"
              />
            </div>
          </div>

          <div className="settings-group">
            <button className="settings-item" onClick={props.onImport} title="从 JSON 导入工具">
              <span className="settings-item-icon">⬆</span>
              <span className="settings-item-label">导入工具</span>
            </button>
            <button className="settings-item" onClick={props.onExport} title="导出全部工具为 JSON">
              <span className="settings-item-icon">⬇</span>
              <span className="settings-item-label">导出全部</span>
            </button>
            <button className="settings-item" onClick={props.onHelp} title="帮助文档">
              <span className="settings-item-icon">?</span>
              <span className="settings-item-label">帮助文档</span>
            </button>
            <button className="settings-item" onClick={props.onVersions} title="全部配置记录">
              <span className="settings-item-icon">⏱</span>
              <span className="settings-item-label">全部配置记录</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SegmentBtn(props: {
  active: boolean;
  onClick: () => void;
  title: string;
  icon: string;
  label: string;
}) {
  return (
    <button
      role="radio"
      aria-checked={props.active}
      className={'seg-btn' + (props.active ? ' active' : '')}
      onClick={props.onClick}
      title={props.title}
    >
      <span className="seg-icon" aria-hidden>{props.icon}</span>
      <span className="seg-label">{props.label}</span>
    </button>
  );
}
