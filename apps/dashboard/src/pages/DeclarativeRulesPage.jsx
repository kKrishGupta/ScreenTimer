import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { PageHeader, Card, Button } from '../components/ui/Card.jsx';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/States.jsx';
import { ShieldIcon, GlobeIcon, DeviceIcon } from '../components/ui/icons.jsx';

export default function DeclarativeRulesPage() {
  const fetchRules = useCallback((opts) => api.declarativeRules(opts), []);
  const { data, loading, error, reload } = useApi(fetchRules, { intervalMs: 5000 });

  const [viewMode, setViewMode] = useState('visual'); // 'visual' | 'json'
  const [testUrl, setTestUrl] = useState('');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  const rules = data?.rules ?? [];
  const count = data?.count ?? rules.length;
  const version = data?.version ?? 1;

  // Filter rules based on search
  const filteredRules = useMemo(() => {
    if (!search.trim()) return rules;
    const q = search.toLowerCase();
    return rules.filter((r) =>
      r.condition?.urlFilter?.toLowerCase().includes(q) ||
      r.action?.redirect?.url?.toLowerCase().includes(q) ||
      String(r.id).includes(q)
    );
  }, [rules, search]);

  // URL Simulator matching logic matching Chrome MV3 urlFilter specs
  const simulationResult = (() => {
    if (!testUrl.trim()) return null;

    let target = testUrl.trim().toLowerCase();
    try {
      if (!target.startsWith('http://') && !target.startsWith('https://')) {
        target = `https://${target}`;
      }
      const parsed = new URL(target);
      const host = parsed.hostname;

      for (const rule of rules) {
        const filter = rule.condition?.urlFilter || '';
        // Handle ||domain match pattern in DNR
        const cleanFilter = filter.replace(/^\|\|/, '');
        if (host === cleanFilter || host.endsWith(`.${cleanFilter}`)) {
          return {
            matched: true,
            rule,
            host,
            redirectUrl: rule.action?.redirect?.url,
          };
        }
      }

      return { matched: false, host };
    } catch {
      return { matched: false, invalidUrl: true };
    }
  })();

  const handleCopyJson = () => {
    const jsonStr = JSON.stringify(data || { rules: [], count: 0, version: 1 }, null, 2);
    navigator.clipboard.writeText(jsonStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadJson = () => {
    const jsonStr = JSON.stringify(data || { rules: [], count: 0, version: 1 }, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `declarative-rules-v${version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) return <LoadingState label="Loading DeclarativeNetRequest Policy Rules…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="MV3 DeclarativeNetRequest Policy Engine"
          description="Zero-latency network-level policy rules compiled for enterprise Chrome and Edge endpoints. Enforces instantaneous client-side redirects before HTTP requests leave the browser."
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={handleCopyJson}
            className="text-xs bg-surface-800 hover:bg-surface-700 text-slate-200 border border-white/10"
          >
            {copied ? '✓ Copied JSON' : 'Copy Raw JSON'}
          </Button>

          <Button
            onClick={handleDownloadJson}
            className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-medium"
          >
            Download rules.json
          </Button>
        </div>
      </div>

      {/* KPI & Quota Badges */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 my-6">
        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Active DNR Rules</p>
          <p className="mt-1 text-2xl font-bold font-mono text-white">{count}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Compiled from active policies</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">MV3 Dynamic Quota</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold font-mono text-emerald-400">{count}</span>
            <span className="text-xs text-slate-500 font-mono">/ 30,000 max</span>
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(1, (count / 30000) * 100)}%` }}></div>
          </div>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Enforcement Action</p>
          <p className="mt-1 text-base font-bold font-mono text-sky-400">REDIRECT</p>
          <p className="text-[10px] text-slate-400 mt-0.5 truncate font-mono">/blocked?domain=...</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Engine Version</p>
          <p className="mt-1 text-2xl font-bold font-mono text-purple-400">v{version}.0</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Manifest V3 compliant</p>
        </div>
      </div>

      {/* URL Simulation & Tester */}
      <Card title="Interactive Policy Rule Simulator" className="mb-6">
        <p className="text-xs text-slate-400 mb-3">
          Simulate endpoint browser navigation against the compiled declarativeNetRequest ruleset in real time:
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type website to test (e.g. roblox.com, twitch.tv, github.com)..."
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
          />
          {testUrl && (
            <button
              onClick={() => setTestUrl('')}
              className="px-3 py-1 text-xs text-slate-400 hover:text-white"
            >
              Clear
            </button>
          )}
        </div>

        {simulationResult && (
          <div className="mt-3">
            {simulationResult.matched ? (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-rose-500/20 text-rose-400 shrink-0">
                    <ShieldIcon width={20} height={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-white font-mono">BLOCKED &bull; Rule #{simulationResult.rule.id}</span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30">
                        {simulationResult.rule.action?.type}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5">
                      Target <span className="font-mono text-rose-300 font-semibold">{simulationResult.host}</span> matches pattern <code className="text-sky-300">{simulationResult.rule.condition?.urlFilter}</code>
                    </p>
                  </div>
                </div>

                <Link
                  to={simulationResult.redirectUrl ? new URL(simulationResult.redirectUrl).pathname + new URL(simulationResult.redirectUrl).search : '/blocked'}
                  className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs shrink-0 text-center transition"
                >
                  Preview Blocked Screen &rarr;
                </Link>
              </div>
            ) : simulationResult.invalidUrl ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-300 font-mono">
                Please enter a valid domain or URL format (e.g. domain.com).
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5 flex items-center gap-3">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0">
                  ✓
                </div>
                <div>
                  <span className="font-bold text-xs text-emerald-300">ALLOW &bull; Request Permitted</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    No declarativeNetRequest blocking rules matched <span className="font-mono text-slate-200">{simulationResult.host}</span>. Network navigation proceeds normally.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Rules Controls & View Toggle */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search rules by domain or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-xs text-slate-400 hover:text-white">
              Clear
            </button>
          )}
        </div>

        {/* View Toggle Tabs */}
        <div className="flex items-center rounded-lg bg-surface-900 p-1 border border-white/10 text-xs">
          <button
            onClick={() => setViewMode('visual')}
            className={`px-3 py-1 rounded-md font-medium transition ${
              viewMode === 'visual'
                ? 'bg-sky-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Visual Rule Cards ({filteredRules.length})
          </button>
          <button
            onClick={() => setViewMode('json')}
            className={`px-3 py-1 rounded-md font-medium transition ${
              viewMode === 'json'
                ? 'bg-sky-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Raw JSON Inspector
          </button>
        </div>
      </div>

      {/* Visual Rule Cards Mode */}
      {viewMode === 'visual' ? (
        filteredRules.length === 0 ? (
          <EmptyState title="No declarative rules found">
            {search ? 'No rules match your filter.' : 'Configure blocking policies in the Website Policies page to compile rules.'}
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredRules.map((rule) => {
              const domain = rule.condition?.urlFilter?.replace(/^\|\|/, '');
              const redirectUrl = rule.action?.redirect?.url;
              let policyName = 'Enterprise Policy';
              try {
                if (redirectUrl) {
                  const urlObj = new URL(redirectUrl);
                  policyName = urlObj.searchParams.get('policy') || 'Enterprise Policy';
                }
              } catch {
                // Ignore parse errors
              }

              return (
                <div
                  key={rule.id}
                  className="rounded-xl border border-white/10 bg-surface-900/60 p-5 shadow-lg space-y-4 hover:border-sky-500/40 transition flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                          ID: #{rule.id}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400 bg-white/5 px-1.5 py-0.5 rounded">
                          Priority {rule.priority || 1}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/20">
                        {rule.action?.type || 'REDIRECT'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-semibold text-slate-500 block">Matched Target Domain</span>
                      <h4 className="text-base font-bold text-white font-mono mt-0.5 flex items-center gap-1.5">
                        <GlobeIcon width={16} height={16} className="text-sky-400" />
                        {domain}
                      </h4>
                      <div className="mt-1 text-[11px] font-mono text-slate-400">
                        Condition: <code className="text-amber-300 bg-black/30 px-1 py-0.5 rounded">{rule.condition?.urlFilter}</code>
                      </div>
                    </div>

                    <div className="rounded-lg bg-surface-950 p-3 border border-white/5 text-xs space-y-1.5 font-mono">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Resource:</span>
                        <span className="text-slate-300">{(rule.condition?.resourceTypes || []).join(', ')}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-slate-500">Linked Policy:</span>
                        <span className="text-rose-300 truncate max-w-[160px]">{policyName}</span>
                      </div>
                      <div className="pt-1 border-t border-white/5 text-[10px] text-slate-500 truncate" title={redirectUrl}>
                        &rarr; {redirectUrl}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end gap-2 border-t border-white/5">
                    {redirectUrl && (
                      <Link
                        to={new URL(redirectUrl).pathname + new URL(redirectUrl).search}
                        className="text-xs font-semibold text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
                      >
                        Preview Blocked Page &rarr;
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Raw JSON Inspector Mode (Exact UI for the raw JSON URL) */
        <div className="rounded-xl border border-white/10 bg-surface-950 shadow-2xl overflow-hidden font-mono text-xs">
          <div className="flex items-center justify-between px-4 py-2.5 bg-surface-900 border-b border-white/5">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-rose-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-amber-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-emerald-500/80"></span>
              <span className="text-[11px] text-slate-400 ml-2 font-mono">GET /api/v1/policies/declarative-rules</span>
            </div>
            <button
              onClick={handleCopyJson}
              className="text-xs text-sky-400 hover:text-sky-300 font-sans"
            >
              {copied ? '✓ Copied' : 'Copy Full JSON'}
            </button>
          </div>

          <div className="p-4 overflow-x-auto max-h-[600px] text-slate-200 leading-relaxed">
            <pre className="font-mono text-xs">
              {JSON.stringify(data, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

