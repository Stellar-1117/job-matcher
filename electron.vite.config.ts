import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { ...alias, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    // Bind to IPv4 explicitly: "localhost" can resolve to ::1 for Vite but 127.0.0.1 for Electron,
    // which leaves the dev window blank (ERR_CONNECTION_REFUSED).
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
