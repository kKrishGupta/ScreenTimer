import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearApiQueryCache, useApi } from '../hooks/useApi.js';

afterEach(() => { clearApiQueryCache(); vi.useRealTimers(); });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('useApi request ownership', () => {
  it('does not overlap polling requests', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useApi(fetcher, { intervalMs: 100, jitterRatio: 0, staleTimeMs: 0 }));

    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ value: 1 }));
    expect(result.current.data).toEqual({ value: 1 });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ value: 2 }));
  });

  it('cancels the active request on manual reload and unmount', async () => {
    const requests = [];
    const fetcher = vi.fn(({ signal }) => {
      const pending = deferred();
      requests.push({ signal, ...pending });
      return pending.promise;
    });
    const { result, unmount } = renderHook(() => useApi(fetcher));
    expect(requests).toHaveLength(1);

    act(() => { result.current.reload(); });
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    unmount();
    expect(requests[1].signal.aborted).toBe(true);
  });

  it('ignores a superseded response even when its fetcher ignores abort', async () => {
    const first = deferred();
    const second = deferred();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useApi(fetcher));
    act(() => { result.current.reload(); });

    await act(async () => second.resolve({ value: 'new' }));
    expect(result.current.data).toEqual({ value: 'new' });
    await act(async () => first.resolve({ value: 'old' }));
    expect(result.current.data).toEqual({ value: 'new' });
  });

  it('preserves loaded data when a reload fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ value: 'retained' })
      .mockRejectedValueOnce(new Error('temporary failure'));
    const { result } = renderHook(() => useApi(fetcher));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'retained' }));
    await act(async () => result.current.reload());
    expect(result.current.data).toEqual({ value: 'retained' });
    expect(result.current.error?.message).toBe('temporary failure');
  });

  it('deduplicates simultaneous consumers with the same query key', async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    const first = renderHook(() => useApi(fetcher, { queryKey: 'shared-resource' }));
    const second = renderHook(() => useApi(fetcher, { queryKey: 'shared-resource' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ value: 'shared' }));
    expect(first.result.current.data).toEqual({ value: 'shared' });
    expect(second.result.current.data).toEqual({ value: 'shared' });
  });

  it('does not poll while the page is hidden', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    renderHook(() => useApi(fetcher, { intervalMs: 100, jitterRatio: 0, staleTimeMs: 0 }));
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(fetcher).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('pauses offline and refreshes immediately after connectivity returns', async () => {
    let connected = false;
    const onlineState = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => connected);
    const fetcher = vi.fn().mockResolvedValue({ value: 'recovered' });
    const { result } = renderHook(() => useApi(fetcher, { queryKey: 'offline-recovery' }));
    expect(fetcher).not.toHaveBeenCalled();

    connected = true;
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'recovered' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    onlineState.mockRestore();
  });
});
