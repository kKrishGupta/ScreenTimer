import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { normalizeBackendUrl } from '../apps/browser-extension/shared/backend-settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Read only the public URL; never copy env files or secrets into the extension.
const env = dotenv.parse(readFileSync(path.join(root, 'backend/.env')));
const value = process.env.EXTENSION_BACKEND_URL || env.EXTENSION_BACKEND_URL;
if (!value) throw new Error('Set EXTENSION_BACKEND_URL in backend/.env before packaging.');
const origin = normalizeBackendUrl(value);
writeFileSync(path.join(root, 'apps/browser-extension/shared/deployment.js'),
  `// Generated public configuration. No secrets.\nexport const BACKEND_URL = ${JSON.stringify(origin)};\n`);
const manifestPath = path.join(root, 'apps/browser-extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [`${origin}/*`];
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Extension configured for the administrator-selected backend.');
