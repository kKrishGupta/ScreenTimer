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
    // Route-level lazy imports can exceed Testing Library's short async query
    // window when many jsdom workers compile pages at once on CI runners.
    // Serial files keep the production-like lazy boundaries deterministic.
    fileParallelism: false,
  },
});
