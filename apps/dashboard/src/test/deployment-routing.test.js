import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const vercelConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));

describe('production API routing', () => {
  it('proxies API requests before the SPA fallback', () => {
    expect(vercelConfig.rewrites[0]).toEqual({
      source: '/api/v1/:path*',
      destination: 'https://screentimer.onrender.com/api/v1/:path*',
    });
    expect(vercelConfig.rewrites.at(-1)).toEqual({
      source: '/(.*)',
      destination: '/index.html',
    });
  });
});
