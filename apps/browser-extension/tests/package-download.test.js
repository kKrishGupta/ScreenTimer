import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageBrowserExtensionDownloads, readZipEntries, verifyExtensionArchive } from '../../../scripts/package-browser-extension-downloads.mjs';

test('dashboard extension downloads are rebuilt from current source and reject stale versions', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'digitalpulse-extension-package-'));
  try {
    const sourceManifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const results = packageBrowserExtensionDownloads({ outputDirectory: output, backendOrigin: 'https://api.example.test' });
    assert.deepEqual(results.map((result) => result.version), [sourceManifest.version, sourceManifest.version]);
    for (const browser of ['chrome', 'edge']) {
      const archive = fs.readFileSync(path.join(output, `digitalpulse-${browser}-extension.zip`));
      const entries = readZipEntries(archive);
      assert(entries.has('manifest.json'));
      assert.equal(JSON.parse(entries.get('manifest.json').toString('utf8')).version, sourceManifest.version);
      assert.match(entries.get('background/sync-client.js').toString('utf8'), /DURATION_REBUILT_FROM_TIMESTAMPS/);
      assert.throws(() => verifyExtensionArchive(archive, '0.0.0-stale'), /does not match source/);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
