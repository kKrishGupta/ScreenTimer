import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const vercelConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'));

describe('production API routing', () => {
  it('pins Vercel to the npm build lifecycle so extension prebuild packaging runs', () => {
    expect(vercelConfig.buildCommand).toBe('npm run build');
    expect(vercelConfig.outputDirectory).toBe('dist');
    const dashboardPackage = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(dashboardPackage.scripts.prebuild).toBe('node ../../scripts/package-browser-extension-downloads.mjs');
    expect(dashboardPackage.scripts.build).toBe('vite build');
  });
  it('protects the reset document from referrer leakage and caching', () => {
    expect(vercelConfig.headers).toContainEqual({
      source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    });
    expect(vercelConfig.headers).toContainEqual({
      source: '/reset-password', headers: [{ key: 'Cache-Control', value: 'no-store' }],
    });
    expect(vercelConfig.headers).toContainEqual({
      source: '/downloads/(.*)', headers: [{ key: 'Cache-Control', value: 'no-store' }],
    });
    expect(readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')).toContain('<meta name="referrer" content="no-referrer" />');
  });
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
