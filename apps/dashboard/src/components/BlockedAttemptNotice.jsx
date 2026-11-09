import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../lib/api.js';

const VIOLATION_FEED_PATHS = new Set([
  '/blocked-activity',
  '/organization/blocked-activity',
  '/policies',
  '/family-policies',
]);

export default function BlockedAttemptNotice({ user }) {
  if (user?.role !== 'ADMIN' || !user.organizationId) return null;
  return <ScopedBlockedAttemptNotice key={`${user.organizationId}:${user.id}`} user={user} />;
}

function ScopedBlockedAttemptNotice({ user }) {
  const [notice, setNotice] = useState(null);
  const location = useLocation();
  const skipDuplicateFeedPoll = VIOLATION_FEED_PATHS.has(location.pathname);

  useEffect(() => {
    if (user?.role !== 'ADMIN' || !user.organizationId || skipDuplicateFeedPoll) return;
    let stopped = false;
    let seen = null;
    let timer;
    let activeController = null;
    async function poll() {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 5000);
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      try {
        const data = await api.policyViolations({ signal: controller.signal });
        if (stopped || controller.signal.aborted) return;
        const rows = data.violations || [];
        const fresh = seen && rows.find((row) => !seen.has(row.id) && row.actionTaken === 'BLOCKED');
        seen = new Set(rows.map((row) => row.id));
        if (fresh) setNotice(fresh);
      } catch { /* Retain previous baseline on transient connection errors. */ }
      finally {
        if (activeController === controller) activeController = null;
        if (!stopped) timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      activeController?.abort(new DOMException('Unmounted', 'AbortError'));
    };
  }, [user?.id, user?.role, user?.organizationId, skipDuplicateFeedPoll]);
  if (!notice) return null;
  return <aside role="alert" className="fixed right-6 top-24 z-50 max-w-sm rounded-xl border border-red-500/40 bg-slate-900 p-5 shadow-xl">
    <strong className="text-red-300">Blocked website attempt</strong>
    <p className="my-2 text-sm text-slate-200">{notice.warningMessage}</p>
    <div className="flex gap-4 text-sm"><Link to="/blocked-activity" onClick={() => setNotice(null)} className="text-cyan-400">View activity</Link>
      <button onClick={() => setNotice(null)} className="text-slate-400">Dismiss</button></div>
  </aside>;
}
