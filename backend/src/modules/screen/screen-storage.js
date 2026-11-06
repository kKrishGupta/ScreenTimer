import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function encryptionKey() {
  const value = process.env.SCREENSHOT_ENCRYPTION_KEY || '';
  if (value.length < 32) throw new Error('SCREENSHOT_ENCRYPTION_KEY must contain at least 32 characters');
  return crypto.createHash('sha256').update(value).digest();
}

function encrypt(bytes) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 29) throw new Error('Encrypted screenshot object is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

function safeSegment(value) {
  const text = String(value || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(text)) throw new Error('Unsafe screenshot object key');
  return text;
}

export function screenshotObjectKey({ organizationId, deviceId, captureId, extension = 'jpg' }) {
  return `${safeSegment(organizationId)}/${safeSegment(deviceId)}/${safeSegment(captureId)}.${safeSegment(extension)}.enc`;
}

class LocalEncryptedStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.provider = 'local-encrypted';
  }

  resolve(key) {
    const target = path.resolve(this.root, ...key.split('/'));
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new Error('Screenshot object escaped the configured storage root');
    return target;
  }

  async put(key, bytes) {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, encrypt(bytes), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async get(key) {
    return decrypt(await fs.readFile(this.resolve(key)));
  }

  async delete(key) {
    try { await fs.unlink(this.resolve(key)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

class S3CompatibleStore {
  constructor(config) {
    this.endpoint = new URL(config.endpoint);
    this.region = config.region;
    this.bucket = config.bucket;
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.provider = 's3-compatible';
  }

  async request(method, key, body = Buffer.alloc(0)) {
    const objectPath = `/${awsEncode(this.bucket)}/${key.split('/').map(awsEncode).join('/')}`;
    const url = new URL(objectPath, this.endpoint);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\nx-amz-server-side-encryption:AES256\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption';
    const canonical = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
    const dateKey = hmac(`AWS4${this.secretKey}`, day);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign, 'hex');
    const response = await fetch(url, {
      method,
      body: method === 'GET' || method === 'DELETE' ? undefined : body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'x-amz-server-side-encryption': 'AES256',
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(`S3-compatible screenshot storage returned HTTP ${response.status}`);
    }
    return response;
  }

  async put(key, bytes) { await this.request('PUT', key, bytes); }
  async get(key) { return Buffer.from(await (await this.request('GET', key)).arrayBuffer()); }
  async delete(key) { await this.request('DELETE', key); }
}

let cached;
export function createScreenshotStore() {
  if (cached) return cached;
  const provider = (process.env.SCREENSHOT_STORAGE_PROVIDER || 'local').toLowerCase();
  if (provider === 'local') {
    const root = process.env.SCREENSHOT_STORAGE_DIR || path.resolve(moduleDir, '../../../storage/screenshots');
    cached = new LocalEncryptedStore(root);
    return cached;
  }
  if (provider === 's3') {
    const required = ['SCREENSHOT_S3_ENDPOINT', 'SCREENSHOT_S3_REGION', 'SCREENSHOT_S3_BUCKET', 'SCREENSHOT_S3_ACCESS_KEY_ID', 'SCREENSHOT_S3_SECRET_ACCESS_KEY'];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`Missing screenshot S3 configuration: ${missing.join(', ')}`);
    cached = new S3CompatibleStore({
      endpoint: process.env.SCREENSHOT_S3_ENDPOINT,
      region: process.env.SCREENSHOT_S3_REGION,
      bucket: process.env.SCREENSHOT_S3_BUCKET,
      accessKey: process.env.SCREENSHOT_S3_ACCESS_KEY_ID,
      secretKey: process.env.SCREENSHOT_S3_SECRET_ACCESS_KEY,
    });
    return cached;
  }
  throw new Error('SCREENSHOT_STORAGE_PROVIDER must be local or s3');
}

export function createViewToken(captureId, userId, expiresAt) {
  const payload = `${captureId}.${userId}.${expiresAt}`;
  const signature = hmac(encryptionKey(), payload, 'base64url');
  return `${expiresAt}.${signature}`;
}

export function verifyViewToken(token, captureId, userId) {
  const [expiresText, signature] = String(token || '').split('.');
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt || !signature) return false;
  const expected = createViewToken(captureId, userId, expiresAt).split('.')[1];
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function resetScreenshotStoreForTests() { cached = null; }
