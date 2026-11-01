import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async API call, exposing { data, error, loading, reload }.
 * Optionally re-polls every `intervalMs` (paused while the tab is hidden).
 */
export function useApi(fetcher, { intervalMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (signal) => {
    try {
      const data = await fetcherRef.current({ signal });
      if (!signal?.aborted) setState({ data, error: null, loading: false });
    } catch (error) {
      if (!signal?.aborted) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    if (!intervalMs) return () => controller.abort();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load(controller.signal);
    }, intervalMs);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load, intervalMs]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return load();
  }, [load]);

  return { ...state, reload };
}

