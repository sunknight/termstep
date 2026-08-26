import type { Tool } from '../../shared/types';

// 网页型工具（kind=web）的主区面板：每个网页工具一个常驻 iframe 实例，与编辑器/
// 预览层同一套「切工具只 display:none 不卸载」模式——切回本工具时网页保持原状态、
// 不重载。URL 配置被保存修改时 src prop 变化自然触发重载；顶栏「刷新」按钮经
// refreshTick 驱动 iframe 的 key 重挂载强制重载（对同一 URL 赋 src 在 WebKit 是
// no-op，跨域 contentWindow.location.reload() 会被拒，remount 是唯一可靠手段）。
export function WebPane(props: {
  /** 全部网页型工具（App 过滤后传入）。 */
  tools: Tool[];
  activeId: string | null;
  /** 每工具的刷新计数：+1 = 强制按配置 URL 重载一次（iframe key 变化 → remount）。 */
  refreshTick: Record<string, number>;
}) {
  return (
    <div className="web-pane">
      {props.tools.map((t) => (
        <WebView
          key={t.meta.id}
          toolId={t.meta.id}
          url={t.meta.webUrl ?? ''}
          active={t.meta.id === props.activeId}
          tick={props.refreshTick[t.meta.id] ?? 0}
        />
      ))}
    </div>
  );
}

function WebView(props: { toolId: string; url: string; active: boolean; tick: number }) {
  return (
    <div className="web-view" style={{ display: props.active ? 'flex' : 'none' }}>
      {props.url ? (
        <iframe
          // tick 进 key：点「刷新」→ key 变化 → iframe 重挂载 → 按配置 URL 全新加载。
          key={props.tick}
          className="web-iframe"
          src={props.url}
          title={props.toolId}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="web-empty">未配置 URL——点「编辑」选择网页类型并填写地址</div>
      )}
    </div>
  );
}
