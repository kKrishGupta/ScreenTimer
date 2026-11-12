import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloads = path.join(root, 'apps', 'dashboard', 'public', 'downloads');
const artifact = path.join(downloads, 'DigitalPulse-Setup.exe');
const release = JSON.parse((await readFile(path.join(downloads, 'DigitalPulse-Setup.release.json'), 'utf8')).replace(/^\uFEFF/, ''));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const binary = await readFile(artifact);
if (binary[0] !== 0x4d || binary[1] !== 0x5a) throw new Error('DigitalPulse-Setup.exe is not a Windows PE executable.');
if (release.schemaVersion !== 1 || release.productVersion !== '0.1.0' || release.fileName !== 'DigitalPulse-Setup.exe') throw new Error('Unsupported Windows installer release metadata.');
if (sha256(binary) !== release.sha256 || (await stat(artifact)).size !== release.bytes) throw new Error('Windows installer artifact is stale or corrupted.');
const checksum = (await readFile(`${artifact}.sha256`, 'utf8')).trim().split(/\s+/)[0];
if (checksum !== release.sha256) throw new Error('Windows installer checksum sidecar does not match.');
for (const [relative, expected] of Object.entries(release.sourceFiles || {})) {
  const current = sha256(await readFile(path.join(root, ...relative.split('/'))));
  if (current !== expected) throw new Error(`Windows installer is stale: ${relative} changed after packaging.`);
}
console.log(`Verified DigitalPulse-Setup.exe ${release.productVersion} (${release.bytes} bytes).`);
