import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../apps/dashboard/', import.meta.url));
const server = await preview({ root, configFile: path.join(root, 'vite.config.js'), preview: { host: '127.0.0.1', port: 0, open: false } });
try {
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  for (const name of ['windows-agent', 'chrome-extension', 'edge-extension']) {
    const relative = `/downloads/digitalpulse-${name}.zip`;
    const head = await fetch(`${base}${relative}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    assert.equal(head.status, 200, relative);
    assert.match(head.headers.get('content-type'), /zip|octet-stream/i);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    const response = await fetch(`${base}${relative}`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, relative);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'Download must be a ZIP, not an HTML SPA fallback');
    const sidecar = await fetch(`${base}${relative}.sha256`, { signal: AbortSignal.timeout(10000) });
    assert.equal(sidecar.status, 200);
    const expected = (await sidecar.text()).trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, expected, 'HTTP download hash must match its published sidecar');
    console.log(`HTTP 200 HEAD/GET verified ${relative}: ${bytes.length} bytes, SHA256 ${actual}`);
  }
} finally {
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
