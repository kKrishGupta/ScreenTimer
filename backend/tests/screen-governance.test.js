import test from 'node:test';
import assert from 'node:assert/strict';
import { v2 as cloudinary } from 'cloudinary';
import { cloudinaryAssetIdentity, createScreenshotStore, createViewToken, resetScreenshotStoreForTests, screenshotObjectKey, verifyViewToken } from '../src/modules/screen/screen-storage.js';

test('screenshot object keys are tenant-scoped and traversal-safe', () => {
  assert.equal(
    screenshotObjectKey({ organizationId: 'org-1', deviceId: 'device-1', captureId: 'capture-1' }),
    'org-1/device-1/capture-1.jpg.enc',
  );
  assert.throws(
    () => screenshotObjectKey({ organizationId: '..', deviceId: 'device-1', captureId: 'capture-1' }),
    /Unsafe screenshot object key/,
  );
});

test('Cloudinary mapping keeps tenant paths private and requires server credentials', () => {
  assert.deepEqual(cloudinaryAssetIdentity('org-1/device-1/capture-1.jpg.enc'), {
    publicId: 'digitalpulse/screenshots/org-1/device-1/capture-1',
    format: 'jpg',
  });
  assert.throws(() => cloudinaryAssetIdentity('../capture.jpg.enc'), /Invalid Cloudinary screenshot object key/);

  const previous = Object.fromEntries([
    'SCREENSHOT_STORAGE_PROVIDER',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ].map((name) => [name, process.env[name]]));
  process.env.SCREENSHOT_STORAGE_PROVIDER = 'cloudinary';
  delete process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_API_KEY;
  delete process.env.CLOUDINARY_API_SECRET;
  resetScreenshotStoreForTests();
  try {
    assert.throws(() => createScreenshotStore(), /Missing Cloudinary screenshot configuration/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetScreenshotStoreForTests();
  }
});

test('Cloudinary provider uploads authenticated assets and uses signed download and deletion', async () => {
  const names = ['SCREENSHOT_STORAGE_PROVIDER', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const environment = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const original = {
    uploadStream: cloudinary.uploader.upload_stream,
    destroy: cloudinary.uploader.destroy,
    privateDownloadUrl: cloudinary.utils.private_download_url,
    fetch: globalThis.fetch,
  };
  const calls = {};
  process.env.SCREENSHOT_STORAGE_PROVIDER = 'cloudinary';
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  cloudinary.uploader.upload_stream = (options, callback) => ({
    end(bytes) {
      calls.upload = { options, bytes };
      callback(null, { public_id: options.public_id, type: 'authenticated' });
    },
  });
  cloudinary.utils.private_download_url = (publicId, format, options) => {
    calls.download = { publicId, format, options };
    return 'https://api.cloudinary.com/signed-download';
  };
  cloudinary.uploader.destroy = async (publicId, options) => {
    calls.destroy = { publicId, options };
    return { result: 'ok' };
  };
  globalThis.fetch = async () => new Response(Buffer.from('private-image'), { status: 200 });
  resetScreenshotStoreForTests();
  try {
    const store = createScreenshotStore();
    const key = 'org-1/device-1/capture-1.jpg.enc';
    await store.put(key, Buffer.from('jpeg'));
    assert.equal(calls.upload.options.type, 'authenticated');
    assert.equal(calls.upload.options.overwrite, false);
    assert.equal(calls.upload.options.public_id, 'digitalpulse/screenshots/org-1/device-1/capture-1');

    assert.equal((await store.get(key)).toString(), 'private-image');
    assert.equal(calls.download.options.type, 'authenticated');
    assert.ok(calls.download.options.expires_at > Math.floor(Date.now() / 1000));

    await store.delete(key);
    assert.equal(calls.destroy.options.type, 'authenticated');
    assert.equal(calls.destroy.options.invalidate, true);
  } finally {
    cloudinary.uploader.upload_stream = original.uploadStream;
    cloudinary.uploader.destroy = original.destroy;
    cloudinary.utils.private_download_url = original.privateDownloadUrl;
    globalThis.fetch = original.fetch;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetScreenshotStoreForTests();
  }
});

test('image access tokens are user-bound, capture-bound, and expire', () => {
  const previous = process.env.SCREENSHOT_ENCRYPTION_KEY;
  process.env.SCREENSHOT_ENCRYPTION_KEY = 'test-only-key-that-is-at-least-32-characters';
  try {
    const expires = Date.now() + 60_000;
    const token = createViewToken('capture-1', 'admin-1', expires);
    assert.equal(verifyViewToken(token, 'capture-1', 'admin-1'), true);
    assert.equal(verifyViewToken(token, 'capture-2', 'admin-1'), false);
    assert.equal(verifyViewToken(token, 'capture-1', 'admin-2'), false);
    const expired = createViewToken('capture-1', 'admin-1', Date.now() - 1);
    assert.equal(verifyViewToken(expired, 'capture-1', 'admin-1'), false);
  } finally {
    if (previous === undefined) delete process.env.SCREENSHOT_ENCRYPTION_KEY;
    else process.env.SCREENSHOT_ENCRYPTION_KEY = previous;
  }
});
