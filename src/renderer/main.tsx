import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <div style={{ padding: 20, fontFamily: 'sans-serif' }}>cmd_gui</div>;
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
