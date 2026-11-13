import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { clearApiQueryCache } from '../hooks/useApi.js';

// Cold route-level dynamic imports need more than Testing Library's one-second
// default on resource-constrained Windows and CI runners.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  clearApiQueryCache();
  vi.restoreAllMocks();
});

