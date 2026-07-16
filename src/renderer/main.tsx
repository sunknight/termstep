import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initTheme } from './lib/theme';
import './styles.css';

// 在 React 渲染前同步初始化主题：读 localStorage + 系统偏好，设好 data-theme，
// 首帧即正确主题，无 FOUC。此时 body 为空，同步设置无副作用。
initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
