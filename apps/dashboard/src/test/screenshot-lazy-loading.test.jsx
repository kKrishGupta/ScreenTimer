import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LazyScreenshotImage from '../components/screenshots/LazyScreenshotImage.jsx';
import { RequestQueue } from '../lib/imageRequestQueue.js';

let intersectionCallback;

beforeEach(() => {
  intersectionCallback = null;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { intersectionCallback = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-screenshot');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

const capture = { id: 'capture-1', employeeName: 'Synthetic Employee', imageUrl: '/private/image?token=redacted' };
const jpeg = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

it('does not request an offscreen screenshot and loads it near the viewport', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/jpeg' }), blob: async () => jpeg });
  vi.stubGlobal('fetch', fetch);
  render(<LazyScreenshotImage capture={capture} />);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => intersectionCallback([{ isIntersecting: true }]));
  expect(await screen.findByAltText('Work screen captured for Synthetic Employee')).toHaveAttribute('src', 'blob:synthetic-screenshot');
  expect(fetch).toHaveBeenCalledWith(capture.imageUrl, expect.objectContaining({ cache: 'no-store', credentials: 'include' }));
});

it('refreshes expired metadata once and shows an explicit failure for invalid image delivery', async () => {
  const expired = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 403, headers: new Headers(), blob: async () => new Blob() })
    .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/html' }), blob: async () => new Blob(['not an image']) });
  vi.stubGlobal('fetch', fetch);
  const view = render(<LazyScreenshotImage capture={capture} eager onExpired={expired} />);
  await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
  view.rerender(<LazyScreenshotImage capture={{ ...capture, imageUrl: '/private/image?token=refreshed' }} eager onExpired={expired} />);
  expect(await screen.findByRole('img', { name: 'Screenshot unavailable' })).toBeInTheDocument();
  expect(expired).toHaveBeenCalledTimes(1);
});

it('limits simultaneous image work to four requests', async () => {
  const queue = new RequestQueue(4);
  let active = 0;
  let maximum = 0;
  let started = 0;
  const releases = [];
  const tasks = Array.from({ length: 8 }, () => queue.run(() => new Promise((resolve) => {
    active += 1;
    started += 1;
    maximum = Math.max(maximum, active);
    releases.push(() => { active -= 1; resolve(); });
  })));
  await waitFor(() => expect(started).toBe(4));
  while (started < 8) {
    const nextStarted = started + 1;
    releases.shift()?.();
    await waitFor(() => expect(started).toBeGreaterThanOrEqual(nextStarted));
  }
  while (releases.length) releases.shift()();
  await Promise.all(tasks);
  expect(maximum).toBe(4);
});
