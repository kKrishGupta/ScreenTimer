import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { normalizeBackendUrl } from '../apps/browser-extension/shared/backend-settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Read only the public URL; never copy env files or secrets into the extension.
const env = dotenv.parse(readFileSync(path.join(root, 'backend/.env')));
const targetArg = process.argv.find((value) => value.startsWith('--target='));
const target = (targetArg?.split('=')[1] || process.env.EXTENSION_DEPLOYMENT || 'local').toLowerCase();
if (!['local', 'production'].includes(target)) throw new Error('Extension target must be local or production.');
const envName = target === 'production' ? 'EXTENSION_PRODUCTION_BACKEND_URL' : 'EXTENSION_LOCAL_BACKEND_URL';
const fallback = target === 'production' ? env.EXTENSION_BACKEND_URL : 'http://127.0.0.1:3001';
const value = process.env[envName] || env[envName] || fallback;
if (!value) throw new Error(`Set ${envName} in backend/.env before building the ${target} extension.`);
const origin = normalizeBackendUrl(value);
if (target === 'production' && (new URL(origin).protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))) throw new Error('Production requires a non-loopback HTTPS backend.');
const outputArg = process.argv.find((value) => value.startsWith('--output-dir='));
const outputDir = outputArg ? path.resolve(outputArg.slice('--output-dir='.length)) : path.join(root, 'apps/browser-extension');
writeFileSync(path.join(outputDir, 'shared/deployment.js'),
  `// Generated public configuration. No secrets.\nexport const DEPLOYMENT = ${JSON.stringify(target)};\nexport const BACKEND_URL = ${JSON.stringify(origin)};\n`);
const manifestPath = path.join(outputDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [`${origin}/*`];
manifest.optional_host_permissions = ['<all_urls>'];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Extension configured for ${target}: ${origin}`);
