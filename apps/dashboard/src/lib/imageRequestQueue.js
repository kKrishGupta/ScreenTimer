export class ImageRequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ImageRequestError';
    this.status = status;
  }
}

export class RequestQueue {
  constructor(limit = 4) {
    this.limit = limit;
    this.active = 0;
    this.pending = [];
  }

  run(task, signal) {
    return new Promise((resolve, reject) => {
      const item = { task, signal, resolve, reject, started: false };
      const abort = () => {
        if (!item.started) this.pending = this.pending.filter((candidate) => candidate !== item);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      item.cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.push(item);
      this.pump();
    });
  }

  pump() {
    while (this.active < this.limit && this.pending.length) {
      const item = this.pending.shift();
      if (item.signal?.aborted) continue;
      item.started = true;
      this.active += 1;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        item.cleanup?.();
        this.active -= 1;
        this.pump();
      });
    }
  }
}

export const screenshotImageQueue = new RequestQueue(4);

function validSignature(bytes, contentType) {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (contentType === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  return false;
}

export async function fetchPrivateScreenshot(url, { signal, queue = screenshotImageQueue } = {}) {
  return queue.run(async () => {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'image/jpeg, image/png' },
      signal,
    });
    if (!response.ok) throw new ImageRequestError('Screenshot image could not be loaded.', response.status);
    const contentType = String(response.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
    const blob = await response.blob();
    const signature = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (!validSignature(signature, contentType)) throw new ImageRequestError('Screenshot response was not a valid image.', response.status);
    return URL.createObjectURL(blob);
  }, signal);
}
