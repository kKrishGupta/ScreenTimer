import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async API call, exposing { data, error, loading, reload }.
 * Optionally re-polls every `intervalMs` (paused while the tab is hidden).
 */
export function useApi(fetcher, { intervalMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetcherRef = useRef(fetcher);
  const mountedRef = useRef(false);
  const requestRef = useRef(null);
  const sequenceRef = useRef(0);
  fetcherRef.current = fetcher;

  const load = useCallback(({ replace = false, showLoading = false } = {}) => {
    const active = requestRef.current;
    if (active && !replace) return active.promise;
    if (active) active.controller.abort(new DOMException('Superseded', 'AbortError'));

    const controller = new AbortController();
    const sequence = ++sequenceRef.current;
    if (showLoading && mountedRef.current) {
      setState((current) => ({ ...current, loading: true }));
    }
    const promise = (async () => {
      try {
        const data = await fetcherRef.current({ signal: controller.signal });
        if (mountedRef.current && !controller.signal.aborted && sequence === sequenceRef.current) {
          setState({ data, error: null, loading: false });
        }
        return data;
      } catch (error) {
        const isCanceled = controller.signal.aborted || error?.code === 'CANCELED' || error?.name === 'AbortError';
        if (mountedRef.current && !isCanceled && sequence === sequenceRef.current) {
          setState((current) => ({ data: current.data, error, loading: false }));
        }
        return undefined;
      } finally {
        if (requestRef.current?.sequence === sequence) requestRef.current = null;
      }
    })();
    requestRef.current = { controller, promise, sequence };
    return promise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load({ replace: true });
    const id = intervalMs ? setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, intervalMs) : null;
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
      requestRef.current?.controller.abort(new DOMException('Unmounted', 'AbortError'));
      requestRef.current = null;
      if (id) clearInterval(id);
    };
  }, [fetcher, load, intervalMs]);

  const reload = useCallback(() => {
    return load({ replace: true, showLoading: true });
  }, [load]);

  return { ...state, reload };
}

