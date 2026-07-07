import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// 统一事件订阅：封装 Tauri listen() 的异步性（返回 Promise<UnlistenFn>），
// 让组件像用同步 cleanup 那样订阅。handler 用 ref 保持最新，不重订阅。
// 对齐 Electron 时代 `return window.api.x.onY(cb)` 当 effect cleanup 的写法。
export function useTauriEvent<T>(name: string, handler: (payload: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let active = true;
    listen<T>(name, (e) => ref.current(e.payload)).then((u) => {
      if (active) un = u;
      else u();
    });
    return () => {
      active = false;
      un?.();
    };
  }, [name]);
}
