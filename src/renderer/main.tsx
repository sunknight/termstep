import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// TEMPORARY: inject a no-op window.api stub before any component renders.
// Stage 1 (Tauri scaffold) has no IPC yet; the stub keeps window.api.* call
// sites from throwing "undefined is not an object" so the UI renders. Removed
// in Stage 2 when src/renderer/lib/api.ts (real Tauri wrappers) replaces it.
import { stubApi } from './lib/stubApi';
if (!window.api) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = stubApi;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
