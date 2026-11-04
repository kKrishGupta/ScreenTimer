import { defineConfig } from 'vitest/config';

// Keep unit tests independent from the Vite dev server's optional native
// Rolldown binding. Vitest can transform the dashboard JSX without loading the
// production React/Tailwind plugins.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
