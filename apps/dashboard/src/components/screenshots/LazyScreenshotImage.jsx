import { useEffect, useRef, useState } from 'react';
import { fetchPrivateScreenshot } from '../../lib/imageRequestQueue.js';

export default function LazyScreenshotImage({ capture, eager = false, onExpired, className = '' }) {
  const hostRef = useRef(null);
  const refreshAttemptedRef = useRef(false);
  const objectUrlRef = useRef('');
  const [nearViewport, setNearViewport] = useState(() => eager || typeof IntersectionObserver === 'undefined');
  const [state, setState] = useState({ status: 'idle', src: '', imageUrl: '' });

  useEffect(() => {
    if (eager || nearViewport) return undefined;
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '300px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, nearViewport]);

  useEffect(() => {
    refreshAttemptedRef.current = false;
  }, [capture.imageUrl]);

  useEffect(() => {
    if (!nearViewport || !capture.imageUrl) return undefined;
    const controller = new AbortController();
    fetchPrivateScreenshot(capture.imageUrl, { signal: controller.signal }).then((src) => {
      if (controller.signal.aborted) { URL.revokeObjectURL(src); return; }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = src;
      setState({ status: 'loaded', src, imageUrl: capture.imageUrl });
    }).catch(async (error) => {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      if ([401, 403].includes(error?.status) && !refreshAttemptedRef.current && onExpired) {
        refreshAttemptedRef.current = true;
        await onExpired(capture.id);
        return;
      }
      setState({ status: 'error', src: '', imageUrl: capture.imageUrl });
    });
    return () => controller.abort(new DOMException('Image no longer needed', 'AbortError'));
  }, [capture.id, capture.imageUrl, nearViewport, onExpired]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const status = state.imageUrl === capture.imageUrl ? state.status : 'loading';
  return <div ref={hostRef} className={`relative grid h-full w-full place-items-center overflow-hidden bg-slate-950 ${className}`}>
    {(status === 'idle' || status === 'loading') && <div aria-label="Loading screenshot" className="absolute inset-0 animate-pulse bg-slate-800/70" />}
    {status === 'error' && <div role="img" aria-label="Screenshot unavailable" className="px-4 text-center text-sm text-slate-400"><span className="block text-xl">!</span>Screenshot unavailable</div>}
    {status === 'loaded' && <img loading="lazy" decoding="async" src={state.src} alt={`Work screen captured for ${capture.employeeName}`} className="h-full w-full object-contain" onError={() => setState({ status: 'error', src: '', imageUrl: capture.imageUrl })} />}
  </div>;
}
