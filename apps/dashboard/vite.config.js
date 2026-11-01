import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dashboard talks to the local backend through the dev-server proxy so the browser
// only ever sees same-origin requests. Everything binds to loopback (Stage 1).
const BACKEND_URL = process.env.DP_BACKEND_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
    },
  },
  preview: {
    host: 'localhost',
    port: 4173,
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});

