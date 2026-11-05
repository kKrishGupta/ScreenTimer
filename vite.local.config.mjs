import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backendUrl = process.env.DP_BACKEND_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  root: 'apps/dashboard',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: backendUrl,
        changeOrigin: false,
      },
    },
  },
});
