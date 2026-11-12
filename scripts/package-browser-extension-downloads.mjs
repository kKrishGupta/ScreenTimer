import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'apps/browser-extension');
const defaultOutput = path.join(repoRoot, 'apps/dashboard/public/downloads');
const runtimeDirectories = ['background', 'popup', 'shared', 'icons'];

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName.replaceAll('\\', '/'));
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const directoryBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBuffer, end]);
}

export function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    assert.equal(method, 0, 'Extension package entries must use deterministic store mode');
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function walkFiles(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Extension package source must not contain symbolic links: ${fullPath}`);
    return entry.isDirectory() ? walkFiles(fullPath, base) : [[path.relative(base, fullPath).replaceAll('\\', '/'), fs.readFileSync(fullPath)]];
  });
}

function productionBackendOrigin() {
  const configured = String(process.env.EXTENSION_PRODUCTION_BACKEND_URL || '').trim();
  if (configured) return new URL(configured).origin;
  const vercel = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/dashboard/vercel.json'), 'utf8'));
  const apiRewrite = vercel.rewrites?.find((rewrite) => rewrite.source.startsWith('/api/'));
  if (!apiRewrite) throw new Error('Production API rewrite is missing; cannot configure extension downloads.');
  return new URL(apiRewrite.destination).origin;
}

function extensionEntries(browser, backendOrigin) {
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const packageManifest = {
    ...sourceManifest,
    host_permissions: [`${backendOrigin}/*`],
    optional_host_permissions: ['<all_urls>'],
  };
  const slug = browser.toLowerCase();
  const readme = fs.readFileSync(path.join(repoRoot, 'docs/installation/browser-extension.txt'), 'utf8')
    .replaceAll('__BROWSER__', browser)
    .replaceAll('__SLUG__', slug)
    .replaceAll('__EXTENSIONS_PAGE__', `${slug}://extensions`);
  const entries = new Map([
    ['manifest.json', Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`)],
    ['README.txt', Buffer.from(readme)],
  ]);
  for (const directory of runtimeDirectories) {
    for (const [relative, content] of walkFiles(path.join(extensionRoot, directory))) {
      const entryName = `${directory}/${relative}`;
      if (!/\.(?:js|html|css|png)$/.test(entryName)) throw new Error(`Unexpected extension package source: ${entryName}`);
      if (!entryName.endsWith('.png') && /dp_(?:sec|enroll|inv)_[a-f0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|postgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@/i.test(content.toString('utf8'))) {
        throw new Error(`Credential-like material detected in extension source: ${entryName}`);
      }
      entries.set(entryName, content);
    }
  }
  entries.set('shared/deployment.js', Buffer.from(`// Generated public configuration. No secrets.\nexport const DEPLOYMENT = "production";\nexport const BACKEND_URL = ${JSON.stringify(backendOrigin)};\n`));
  return entries;
}

export function verifyExtensionArchive(buffer, expectedVersion) {
  const entries = readZipEntries(buffer);
  assert(entries.has('manifest.json'), 'ZIP must contain manifest.json at its root');
  assert(![...entries.keys()].some((name) => name.split('/')[0].includes('digitalpulse-')), 'ZIP must not wrap the extension in a stale package directory');
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(manifest.version, expectedVersion, `Packaged extension ${manifest.version} does not match source ${expectedVersion}`);
  const syncClient = entries.get('background/sync-client.js')?.toString('utf8') || '';
  const worker = entries.get('background/service-worker.js')?.toString('utf8') || '';
  assert.match(syncClient, /QUARANTINE_STORAGE_KEY/);
  assert.match(syncClient, /prepareQueue/);
  assert.match(worker, /export_activity_quarantine/);
  return { manifest, entries };
}

export function packageBrowserExtensionDownloads({ outputDirectory = defaultOutput, backendOrigin = productionBackendOrigin() } = {}) {
  const origin = new URL(backendOrigin);
  if (origin.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Production extension packages require a non-loopback HTTPS backend.');
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.equal(packageMetadata.version, sourceManifest.version, 'Extension package.json and manifest.json versions must match');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const results = [];
  for (const browser of ['Chrome', 'Edge']) {
    const name = `digitalpulse-${browser.toLowerCase()}-extension.zip`;
    const buffer = zipEntries([...extensionEntries(browser, origin.origin)]);
    verifyExtensionArchive(buffer, sourceManifest.version);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    fs.writeFileSync(path.join(outputDirectory, name), buffer);
    fs.writeFileSync(path.join(outputDirectory, `${name}.sha256`), `${hash}  ${name}\n`, 'ascii');
    results.push({ name, version: sourceManifest.version, bytes: buffer.length, sha256: hash });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputArg = process.argv.find((value) => value.startsWith('--output-dir='));
  const backendArg = process.argv.find((value) => value.startsWith('--backend-url='));
  const results = packageBrowserExtensionDownloads({
    ...(outputArg ? { outputDirectory: path.resolve(outputArg.slice('--output-dir='.length)) } : {}),
    ...(backendArg ? { backendOrigin: backendArg.slice('--backend-url='.length) } : {}),
  });
  for (const result of results) console.log(`Packaged ${result.name} v${result.version}: ${result.bytes} bytes, SHA256 ${result.sha256}`);
}
