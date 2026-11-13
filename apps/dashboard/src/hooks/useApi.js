import { useCallback, useEffect, useRef, useState } from 'react';

const queryCache = new Map();
const cacheResetListeners = new Set();
const fetcherIds = new WeakMap();
let nextFetcherId = 1;

function cacheKey(fetcher, queryKey) {
  if (queryKey !== undefined) return typeof queryKey === 'string' ? queryKey : JSON.stringify(queryKey);
  if (!fetcherIds.has(fetcher)) fetcherIds.set(fetcher, nextFetcherId++);
  return `fetcher:${fetcherIds.get(fetcher)}`;
}

function online() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function visible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function clearApiQueryCache({ refetch = false } = {}) {
  for (const entry of queryCache.values()) entry.controller?.abort(new DOMException('Cache cleared', 'AbortError'));
  queryCache.clear();
  if (refetch) for (const listener of cacheResetListeners) listener();
}

export function invalidateApiQuery(queryKey) {
  const key = typeof queryKey === 'string' ? queryKey : JSON.stringify(queryKey);
  const entry = queryCache.get(key);
  if (entry) entry.updatedAt = 0;
}

/**
 * Shared, abortable GET cache for dashboard data. Concurrent consumers with the
 * same query key share one request. Polling pauses while hidden or offline and
 * uses jitter so multiple dashboards do not wake a free-tier backend together.
 */
export function useApi(fetcher, {
  intervalMs,
  staleTimeMs = 30_000,
  queryKey,
  enabled = true,
  jitterRatio = 0.1,
} = {}) {
  const key = cacheKey(fetcher, queryKey);
  const initial = queryCache.get(key);
  const [state, setState] = useState(() => ({
    data: initial?.data ?? null,
    error: initial?.error ?? null,
    loading: enabled && !initial?.data,
  }));
  const fetcherRef = useRef(fetcher);
  const mountedRef = useRef(false);
  const sequenceRef = useRef(0);
  const observerIdRef = useRef(Symbol('api-observer'));
  fetcherRef.current = fetcher;

  const load = useCallback(async ({ replace = false, showLoading = false } = {}) => {
    if (!enabled || !online()) return undefined;
    let entry = queryCache.get(key);
    const fresh = entry?.data !== undefined && Date.now() - entry.updatedAt < staleTimeMs;
    if (!replace && fresh) {
      if (mountedRef.current) setState({ data: entry.data, error: null, loading: false });
      return entry.data;
    }
    if (entry?.promise && entry.controller?.signal.aborted) entry.promise = null;
    if (entry?.promise && !replace) {
      const data = await entry.promise;
      if (mountedRef.current && data !== undefined) setState({ data, error: entry.error, loading: false });
      return data;
    }
    if (entry?.promise && replace) entry.controller.abort(new DOMException('Superseded', 'AbortError'));

    const controller = new AbortController();
    const sequence = ++sequenceRef.current;
    entry = entry || { observers: new Set(), data: undefined, error: null, updatedAt: 0 };
    entry.controller = controller;
    entry.observers.add(observerIdRef.current);
    queryCache.set(key, entry);
    if (mountedRef.current && (showLoading || entry.data === undefined)) {
      setState((current) => ({ ...current, loading: true }));
    }
    const promise = (async () => {
      try {
        const data = await fetcherRef.current({ signal: controller.signal });
        if (!controller.signal.aborted) {
          entry.data = data;
          entry.error = null;
          entry.updatedAt = Date.now();
          if (mountedRef.current && sequence === sequenceRef.current) setState({ data, error: null, loading: false });
        }
        return data;
      } catch (error) {
        const canceled = controller.signal.aborted || error?.code === 'CANCELED' || error?.name === 'AbortError';
        if (!canceled) {
          entry.error = error;
          if (mountedRef.current && sequence === sequenceRef.current) {
            setState((current) => ({ data: entry.data ?? current.data, error, loading: false }));
          }
        }
        return undefined;
      } finally {
        if (entry.controller === controller) {
          entry.promise = null;
          entry.controller = null;
        }
      }
    })();
    entry.promise = promise;
    return promise;
  }, [enabled, key, staleTimeMs]);

  useEffect(() => {
    mountedRef.current = true;
    const observerId = observerIdRef.current;
    let timer = null;
    const entry = queryCache.get(key) || { observers: new Set(), data: undefined, error: null, updatedAt: 0 };
    entry.observers.add(observerId);
    queryCache.set(key, entry);
    load();

    const schedule = () => {
      if (!intervalMs || !enabled) return;
      clearTimeout(timer);
      const jitter = intervalMs * jitterRatio * ((Math.random() * 2) - 1);
      timer = setTimeout(async () => {
        if (visible() && online()) await load();
        schedule();
      }, Math.max(1_000, intervalMs + jitter));
    };
    const resume = () => {
      if (visible() && online()) load();
      schedule();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', resume);
      window.addEventListener('offline', schedule);
    }
    const refreshAfterScopeChange = () => load({ replace: true });
    cacheResetListeners.add(refreshAfterScopeChange);
    schedule();
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', resume);
        window.removeEventListener('offline', schedule);
      }
      cacheResetListeners.delete(refreshAfterScopeChange);
      const current = queryCache.get(key);
      current?.observers.delete(observerId);
      if (current?.promise && current.observers.size === 0) current.controller?.abort(new DOMException('No active observers', 'AbortError'));
    };
  }, [enabled, intervalMs, jitterRatio, key, load]);

  const reload = useCallback(() => load({ replace: true, showLoading: true }), [load]);
  return { ...state, reload };
}
