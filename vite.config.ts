import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Tauri 期望的固定端口（与 tauri.conf.json 的 devUrl 对应）。
// clearScreen 让 Tauri 的 cargo 输出不被 Vite 清屏覆盖。
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri 同时启动一个 Rust 进程和一个前端 dev server；
    // 监听 host 防止 dev server 在某些环境绑定到错误地址。
    host: '0.0.0.0',
    watch: {
      // 不监听 Rust 源码（Tauri 自己管）
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 用 webview 加载，目标现代浏览器
    target: 'es2022',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
