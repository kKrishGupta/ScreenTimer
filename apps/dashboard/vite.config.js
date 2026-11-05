import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dashboard talks to the local backend through the dev-server proxy so the browser
// only ever sees same-origin requests. Everything binds to loopback (Stage 1).
const BACKEND_URL = process.env.DP_BACKEND_URL ?? 'http://127.0.0.1:3001';
const DASHBOARD_HOST = process.env.DP_DASHBOARD_HOST ?? 'localhost';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: { 'Referrer-Policy': 'no-referrer' },
    host: DASHBOARD_HOST,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'BACKEND_OFFLINE', message: 'Fastify backend is offline on 127.0.0.1:3001' } }));
            }
          });
        },
      },
    },
  },
  preview: {
    headers: { 'Referrer-Policy': 'no-referrer' },
    host: DASHBOARD_HOST,
    port: 4173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'BACKEND_OFFLINE', message: 'Fastify backend is offline on 127.0.0.1:3001' } }));
            }
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
