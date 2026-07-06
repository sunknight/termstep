import { Component, type ReactNode, type ErrorInfo } from 'react';

// App-wide safety net. Without a boundary, an uncaught error during render
// unmounts the ENTIRE React tree → blank window (this is exactly what happened
// when a stale preload made window.api.clipboard undefined and QuickAddModal
// threw on mount). This boundary turns any such crash into a visible fallback
// with the error message and a reload action, instead of a white screen. The
// fallback uses inline styles on purpose — it must render even if styles.css
// itself is what broke. Mount once, around <App/>.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Mirror to the renderer console so DevTools shows the real cause even when
    // the screen would otherwise have gone blank.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      const msg = this.state.error?.message ?? String(this.state.error);
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#222' }}>
          <h2 style={{ margin: '0 0 8px' }}>出错了</h2>
          <p style={{ margin: '0 0 12px', color: '#666' }}>
            界面渲染时遇到错误。可以重新加载继续；若反复出现，请打开开发者工具查看控制台。
          </p>
          <pre
            style={{
              background: '#f4f4f6',
              padding: 10,
              borderRadius: 6,
              overflow: 'auto',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg}
          </pre>
          <button
            onClick={() => location.reload()}
            style={{
              marginTop: 12,
              padding: '6px 14px',
              fontSize: 13,
              cursor: 'pointer',
              border: '1px solid #cfd2da',
              borderRadius: 6,
              background: '#4a6cff',
              color: '#fff',
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
