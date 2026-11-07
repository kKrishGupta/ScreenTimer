import { useState, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import WebsiteBlockingControls from '../components/WebsiteBlockingControls.jsx';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';

function formatTimestamp(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + d.toLocaleDateString();
}

export default function BlockedActivityPage() {
  const fetchViolations = useCallback((opts) => api.policyViolations(opts), []);
  const { data: violationsData, error, loading, reload } = useApi(fetchViolations, { intervalMs: 5000 });

  const fetchGrace = useCallback((opts) => api.graceGrants(opts), []);
  const { data: graceData } = useApi(fetchGrace, { intervalMs: 5000 });

  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('ALL');

  const violations = violationsData?.violations || [];
  const graceGrants = graceData?.grants || [];

  const summary = useMemo(() => {
    const uniqueDomains = new Set(violations.map((v) => v.target));
    const activeGraceCount = graceGrants.filter((g) => g.status === 'GRACE_ACTIVE').length;
    
    // Determine most blocked domain
    const domainCounts = {};
    violations.forEach((v) => {
      domainCounts[v.target] = (domainCounts[v.target] || 0) + 1;
    });
    let topDomain = 'None';
    let maxCount = 0;
    for (const [dom, cnt] of Object.entries(domainCounts)) {
      if (cnt > maxCount) {
        maxCount = cnt;
        topDomain = dom;
      }
    }

    return {
      totalAttempts: violations.length,
      uniqueDomainsCount: uniqueDomains.size,
      activeGraceCount,
      topBlockedDomain: topDomain,
      topDomainAttempts: maxCount,
    };
  }, [violations, graceGrants]);

  const filteredViolations = useMemo(() => {
    return violations.filter((v) => {
      if (filterType === 'UNACKNOWLEDGED' && v.acknowledged) return false;
      if (filterType === 'CRITICAL' && v.severity !== 'critical') return false;

      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchesTarget = v.target?.toLowerCase().includes(q);
        const matchesPolicy = v.policyName?.toLowerCase().includes(q);
        const matchesEmployee = (v.employee || '')?.toLowerCase().includes(q);
        if (!matchesTarget && !matchesPolicy && !matchesEmployee) return false;
      }
      return true;
    });
  }, [violations, filterType, search]);

  const handleAcknowledge = async (id) => {
    try {
      await api.acknowledgeViolation(id);
      reload();
    } catch {
      // safe fallback
    }
  };

  if (loading && !violationsData) {
    return <LoadingState label="Loading blocked website intelligence feed…" />;
  }

  if (error) {
    return <ErrorState error={error} onRetry={reload} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Blocked Website & Policy Restriction Intelligence"
        description="Comprehensive audit of restricted domain access attempts, corporate policy enforcements, and temporary grace authorizations."
      >
        <div className="flex items-center gap-2">
          <Button onClick={reload} className="text-xs">
            Refresh Feed
          </Button>
        </div>
      </PageHeader>

      <WebsiteBlockingControls />

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-4">
          <div className="text-xs font-medium text-rose-400">Blocked Attempts</div>
          <div className="mt-2 text-2xl font-bold text-rose-300">{summary.totalAttempts}</div>
          <div className="mt-1 text-xs text-rose-500/80">Restricted navigations caught</div>
        </div>

        <div className="rounded-xl border border-white/5 bg-surface-900/80 p-4">
          <div className="text-xs font-medium text-slate-400">Unique Blocked Domains</div>
          <div className="mt-2 text-2xl font-bold text-white">{summary.uniqueDomainsCount}</div>
          <div className="mt-1 text-xs text-slate-500">Restricted hostnames</div>
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4">
          <div className="text-xs font-medium text-amber-400">Active Grace Grants</div>
          <div className="mt-2 text-2xl font-bold text-amber-300">{summary.activeGraceCount}</div>
          <div className="mt-1 text-xs text-amber-500/80">Temporary 15m approvals</div>
        </div>

        <div className="rounded-xl border border-white/5 bg-surface-900/80 p-4">
          <div className="text-xs font-medium text-slate-400">Top Restricted Target</div>
          <div className="mt-2 truncate font-mono text-sm font-semibold text-rose-300" title={summary.topBlockedDomain}>
            {summary.topBlockedDomain}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {summary.topDomainAttempts > 0 ? `${summary.topDomainAttempts} attempt(s)` : 'No attempts'}
          </div>
        </div>
      </div>

      {/* Critical Guidance Banner */}
      <div className="rounded-lg border border-sky-500/20 bg-sky-950/20 p-3 text-xs text-sky-300 flex items-center justify-between">
        <div>
          <span className="font-semibold text-white">Productivity Distinction Notice: </span>
          Blocked website navigation attempts are intercepted at the network level and do <strong>not</strong> contribute to an employee's recorded website usage duration.
        </div>
        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-200">
          MV3 Enforced
        </span>
      </div>

      {/* Filter Bar */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by domain, policy name, or employee…"
              className="w-full rounded-lg border border-white/10 bg-surface-800 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-accent-400 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setFilterType('ALL')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filterType === 'ALL'
                  ? 'border border-accent-400/30 bg-accent-500/20 text-accent-300'
                  : 'bg-surface-800 text-slate-400 hover:text-white'
              }`}
            >
              All Events ({violations.length})
            </button>
            <button
              onClick={() => setFilterType('UNACKNOWLEDGED')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filterType === 'UNACKNOWLEDGED'
                  ? 'border border-rose-500/30 bg-rose-500/20 text-rose-300'
                  : 'bg-surface-800 text-slate-400 hover:text-white'
              }`}
            >
              Unacknowledged ({violations.filter((v) => !v.acknowledged).length})
            </button>
            <button
              onClick={() => setFilterType('CRITICAL')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filterType === 'CRITICAL'
                  ? 'border border-amber-500/30 bg-amber-500/20 text-amber-300'
                  : 'bg-surface-800 text-slate-400 hover:text-white'
              }`}
            >
              Critical Blocks
            </button>
          </div>
        </div>
      </Card>

      {/* Blocked Events Table */}
      <Card>
        {filteredViolations.length === 0 ? (
          <EmptyState title="No blocked domain violations recorded">
            {search || filterType !== 'ALL'
              ? 'Try adjusting your search query or filter settings.'
              : 'Zero blocked domain attempts have occurred. When an employee attempts to navigate to a blocked domain, the interception event will appear here.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="pb-3 font-semibold">Timestamp</th>
                  <th className="pb-3 font-semibold">Restricted Target</th>
                  <th className="pb-3 font-semibold">Employee / Username</th>
                  <th className="pb-3 font-semibold">Enforced Policy</th>
                  <th className="pb-3 font-semibold">Action & Outcome</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredViolations.map((v) => (
                  <tr key={v.id} className="transition hover:bg-white/[0.02]">
                    <td className="py-3 pr-4 font-mono text-[11px] text-slate-400">
                      {formatTimestamp(v.timestamp)}
                    </td>

                    <td className="py-3 pr-4">
                      <span className="font-mono font-semibold text-rose-400">{v.target}</span>
                      <div className="text-[10px] text-slate-500 uppercase">{v.targetType || 'Website'}</div>
                    </td>

                    <td className="py-3 pr-4 font-medium text-slate-200">
                      <div>{v.employee || 'Organization User'}</div>
                      {v.username && v.username !== v.employee && <div className="mt-1 text-[10px] font-normal text-slate-500">{v.username}</div>}
                      <div className="mt-1 text-[10px] font-normal text-slate-500">Attempted at {formatTimestamp(v.timestamp)}</div>
                    </td>

                    <td className="py-3 pr-4 text-slate-300">
                      {v.policyName}
                    </td>

                    <td className="py-3 pr-4">
                      {v.enforcementResult === 'TEMPORARY_ACCESS_GRANTED' ? (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 border border-amber-500/20">
                          Temporary Grace Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400 border border-rose-500/20">
                          Main Frame Redirected
                        </span>
                      )}
                    </td>

                    <td className="py-3 pr-4">
                      {v.acknowledged ? (
                        <span className="text-slate-500 text-[11px]">Acknowledged</span>
                      ) : (
                        <span className="inline-block h-2 w-2 rounded-full bg-rose-400 animate-pulse" title="Requires review"></span>
                      )}
                    </td>

                    <td className="py-3 text-right">
                      {!v.acknowledged ? (
                        <button
                          onClick={() => handleAcknowledge(v.id)}
                          className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition hover:border-accent-400 hover:text-white"
                        >
                          Acknowledge
                        </button>
                      ) : (
                        <span className="text-slate-600 text-[11px]">Reviewed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

