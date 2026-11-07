import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MAX_STORED_IMAGE_BYTES = 5 * 1024 * 1024;

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
  if (!/^[a-zA-Z0-9._-]+$/.test(text) || text === '.' || text === '..') throw new Error('Unsafe screenshot object key');
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

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

export function cloudinaryAssetIdentity(key) {
  const match = String(key || '').match(/^([a-zA-Z0-9._/-]+)\.(jpg|png)\.enc$/);
  if (!match || match[1].split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid Cloudinary screenshot object key');
  }
  return {
    publicId: `digitalpulse/screenshots/${match[1]}`,
    format: match[2],
  };
}

class CloudinaryAuthenticatedStore {
  constructor(config) {
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: true,
    });
    this.client = cloudinary;
    this.provider = 'cloudinary-authenticated';
  }

  async put(key, bytes) {
    const { publicId, format } = cloudinaryAssetIdentity(key);
    await new Promise((resolve, reject) => {
      const stream = this.client.uploader.upload_stream({
        public_id: publicId,
        resource_type: 'image',
        type: 'authenticated',
        format,
        overwrite: false,
        unique_filename: false,
        use_filename: false,
        tags: ['digitalpulse-screenshot'],
      }, (error, result) => {
        if (error) reject(error);
        else if (!result || result.public_id !== publicId || result.type !== 'authenticated') reject(new Error('Cloudinary returned invalid authenticated upload metadata'));
        else resolve(result);
      });
      stream.end(bytes);
    });
  }

  async get(key) {
    const { publicId, format } = cloudinaryAssetIdentity(key);
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const signedUrl = this.client.utils.private_download_url(publicId, format, {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: expiresAt,
      attachment: false,
    });
    const url = new URL(signedUrl);
    if (url.protocol !== 'https:' || (!url.hostname.endsWith('.cloudinary.com') && url.hostname !== 'cloudinary.com')) {
      throw new Error('Cloudinary generated an unsafe download URL');
    }
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cloudinary screenshot download returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_STORED_IMAGE_BYTES) throw new Error('Cloudinary screenshot exceeds the maximum image size');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_STORED_IMAGE_BYTES) throw new Error('Cloudinary screenshot exceeds the maximum image size');
    return bytes;
  }

  async delete(key) {
    const { publicId } = cloudinaryAssetIdentity(key);
    const result = await this.client.uploader.destroy(publicId, {
      resource_type: 'image',
      type: 'authenticated',
      invalidate: true,
    });
    if (!['ok', 'not found'].includes(result?.result)) throw new Error('Cloudinary did not confirm screenshot deletion');
  }
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
  if (provider === 'cloudinary') {
    const required = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`Missing Cloudinary screenshot configuration: ${missing.join(', ')}`);
    cached = new CloudinaryAuthenticatedStore({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      apiSecret: process.env.CLOUDINARY_API_SECRET,
    });
    return cached;
  }
  throw new Error('SCREENSHOT_STORAGE_PROVIDER must be local or cloudinary');
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
