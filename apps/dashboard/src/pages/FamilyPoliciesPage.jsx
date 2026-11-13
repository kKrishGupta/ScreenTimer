import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { ShieldIcon } from '../components/ui/icons.jsx';

export default function FamilyPoliciesPage() {
  const fetchPolicies = useCallback((opts) => api.policies(opts), []);
  const fetchViolations = useCallback((opts) => api.policyViolations(opts), []);
  const fetchGraceGrants = useCallback((opts) => api.graceGrants(opts), []);

  const { data: policiesData, loading: policiesLoading, reload: reloadPolicies } = useApi(fetchPolicies, { intervalMs: 60_000, staleTimeMs: 30_000 });
  const { data: violationsData, loading: violationsLoading, reload: reloadViolations } = useApi(fetchViolations, { intervalMs: 60_000, staleTimeMs: 30_000 });
  const { data: graceData, reload: reloadGrace } = useApi(fetchGraceGrants, { intervalMs: 30_000, staleTimeMs: 15_000 });

  const [newPolicyName, setNewPolicyName] = useState('');
  const [newCategory, setNewCategory] = useState('social_media');
  const [newRestricted, setNewRestricted] = useState('reddit.com, twitter.com');
  const [newMaxMinutes, setNewMaxMinutes] = useState(45);
  const [newStrictness, setNewStrictness] = useState(0); // Initial & minimum value is 0 (Section 3 requirement)
  const [newAction, setNewAction] = useState('temporary_access');
  const [newTempDuration, setNewTempDuration] = useState(15);
  const [simDomain, setSimDomain] = useState('tiktok.com');
  const [simResult, setSimResult] = useState(null);
  const [graceDomainInput, setGraceDomainInput] = useState('instagram.com');
  const [busy, setBusy] = useState(false);

  const policies = policiesData?.policies ?? [];
  const violations = violationsData?.violations ?? [];
  const graceGrants = graceData?.grants ?? [];

  const getStrictnessLabel = (val) => {
    if (val === 0) return '0 — Least Restrictive (Permissive audit logging & telemetry only)';
    if (val <= 25) return `${val} — Low Restriction (Advisory warnings on unclassified/suspicious domains)`;
    if (val <= 50) return `${val} — Moderate Restriction (Warn on social media & gaming during focus)`;
    if (val <= 75) return `${val} — High Restriction (Temporary 15m access allowance, strict countdown)`;
    return `${val} — Strictest Restriction (Strict blocking of non-whitelisted domains)`;
  };

  const handleCreatePolicy = async (e) => {
    e.preventDefault();
    if (!newPolicyName.trim()) return;
    try {
      setBusy(true);
      const restrictedDomains = newRestricted.split(',').map((d) => d.trim()).filter(Boolean);
      await api.createPolicy({
        name: newPolicyName.trim(),
        category: newCategory,
        strictness: Number(newStrictness),
        restrictedDomains,
        maxMinutesPerDay: Number(newMaxMinutes),
        temporaryAccessMinutes: Number(newTempDuration),
        action: newAction,
        active: true,
      });
      setNewPolicyName('');
      setNewStrictness(0);
      reloadPolicies();
    } catch (err) {
      alert(`Error creating policy: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleResetStrictness = async (policyId) => {
    if (!confirm('Reset strictness to 0 (Least Restrictive) for this policy?')) return;
    try {
      setBusy(true);
      const res = await api.resetStrictness(policyId);
      alert(res.message || 'Strictness reset to 0');
      reloadPolicies();
    } catch (err) {
      alert(`Error resetting strictness: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePolicy = async (policy) => {
    try {
      await api.updatePolicy(policy.id, { active: !policy.active });
      reloadPolicies();
    } catch (err) {
      alert(`Error updating policy: ${err.message}`);
    }
  };

  const handleDeletePolicy = async (id) => {
    try {
      await api.deletePolicy(id);
      reloadPolicies();
    } catch (err) {
      alert(`Error deleting policy: ${err.message}`);
    }
  };

  const handleSimulateCheck = async (e) => {
    e.preventDefault();
    if (!simDomain.trim()) return;
    try {
      setBusy(true);
      const res = await api.checkPolicy({ domain: simDomain.trim() });
      setSimResult(res);
      reloadViolations();
    } catch (err) {
      alert(`Policy check error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAcknowledge = async (id) => {
    try {
      await api.acknowledgeViolation(id);
      reloadViolations();
    } catch (err) {
      alert(`Error acknowledging: ${err.message}`);
    }
  };

  const handleSimulateGraceVisit = async (domain) => {
    try {
      setBusy(true);
      const res = await api.graceVisit(domain || graceDomainInput);
      alert(res.message);
      reloadGrace();
    } catch (err) {
      alert(`Grace visit error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAdminReset = async (domain) => {
    try {
      setBusy(true);
      const res = await api.graceReset(domain, 15);
      alert(res.message);
      reloadGrace();
    } catch (err) {
      alert(`Grace reset error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Enterprise Website Access Policies & Governance"
          description="Enterprise domain limits, temporary access workflows, strictness tuning (0–100), and policy violations."
        />
      </div>

      {/* Live Policy Simulation Box */}
      <div className="my-6 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
          <ShieldIcon width={16} height={16} />
          Policy Engine Simulator (Test Restricted Domain Evaluation)
        </h3>
        <p className="text-xs text-slate-400 mb-4">
          Test how DigitalPulse detects restricted websites in real time, emits a soft warning advisory, and logs a violation event.
        </p>
        <form onSubmit={handleSimulateCheck} className="flex gap-2 max-w-xl">
          <input
            type="text"
            placeholder="Enter domain (e.g. tiktok.com, roblox.com, wikipedia.org)..."
            value={simDomain}
            onChange={(e) => setSimDomain(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
          />
          <Button type="submit" disabled={busy || !simDomain.trim()} className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-medium">
            Test Evaluation
          </Button>
        </form>

        {simResult && (
          <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-white/5 pb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Policy Evaluation Result</span>
              <span className={`px-2.5 py-0.5 rounded text-[11px] font-bold ${
                simResult.enforcementResult === 'RESTRICTION_ENFORCED_BLOCKED'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                  : simResult.enforcementResult === 'TEMPORARY_ACCESS_GRANTED'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : simResult.enforcementResult === 'WARNING_ISSUED'
                  ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
              }`}>
                {simResult.enforcementResult || (simResult.restricted ? 'RESTRICTION_ENFORCED_BLOCKED' : 'ALLOWED')}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Website / Domain</p>
                <p className="font-mono font-bold text-sky-400 truncate mt-0.5">{simResult.website || simResult.domain || simDomain}</p>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Policy Name</p>
                <p className="font-semibold text-slate-200 truncate mt-0.5">{simResult.policyName || simResult.policy || 'Default Permissive'}</p>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Employee / Device</p>
                <p className="font-mono text-slate-300 truncate mt-0.5">{simResult.employee || 'Local Employee'} &bull; {simResult.device || 'Windows 11'}</p>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Attempt Time</p>
                <p className="font-mono text-slate-300 truncate mt-0.5">{simResult.accessAttemptTime ? new Date(simResult.accessAttemptTime).toLocaleTimeString() : new Date().toLocaleTimeString()}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Temporary Access Expiry</p>
                <p className="font-mono text-amber-300 mt-0.5">
                  {simResult.temporaryAccessExpiry ? new Date(simResult.temporaryAccessExpiry).toLocaleTimeString() : 'Not applicable / Permanent'}
                </p>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Enforcement Result</p>
                <p className="font-semibold text-slate-200 mt-0.5">{simResult.enforcementResult || (simResult.restricted ? 'Blocked' : 'Allowed')}</p>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <p className="text-[10px] text-slate-500 uppercase">Admin Notification Status</p>
                <p className="font-mono text-emerald-400 mt-0.5 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  {simResult.adminNotificationStatus || 'SENT (Alert Feed)'}
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-white/[0.03] p-3 text-xs text-slate-300 border border-white/5">
              <span className="font-semibold text-white">Advisory: </span>
              {simResult.warningMessage || (simResult.restricted ? 'Website access restricted under policy.' : 'Access compliant with enterprise policy.')}
            </div>
          </div>
        )}
      </div>

      {/* Enterprise 15-Minute Grace Period State Machine */}
      <div className="my-6 rounded-xl border border-purple-500/20 bg-purple-950/10 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse"></span>
              Enterprise 15-Minute Grace Period State Machine
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Deterministic state transitions: <span className="font-mono text-slate-300">NOT_VISITED &rarr; GRACE_ACTIVE (15m countdown) &rarr; BLOCKED &rarr; ADMIN_RESET</span>.
              Server-authoritative timer in PostgreSQL persists across tab refreshes, browser switches (Chrome &harr; Edge), and restarts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/policies/declarative-rules"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 border border-purple-500/30 text-xs font-mono font-medium transition"
            >
              <ShieldIcon width={13} height={13} className="text-purple-400" />
              MV3 Rules Inspector &rarr;
            </Link>
          </div>
        </div>

        <div className="flex gap-2 max-w-xl mb-4">
          <input
            type="text"
            placeholder="Simulate visit to domain (e.g. instagram.com)..."
            value={graceDomainInput}
            onChange={(e) => setGraceDomainInput(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:border-purple-400 focus:outline-none"
          />
          <Button
            onClick={() => handleSimulateGraceVisit(graceDomainInput)}
            disabled={busy || !graceDomainInput.trim()}
            className="text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium"
          >
            Start / Check Grace Period
          </Button>
        </div>

        {graceGrants.length === 0 ? (
          <p className="text-xs text-slate-500 italic">No domain grace periods initiated yet today. Enter a domain above to test first visit.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-2 px-3">Domain</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Remaining</th>
                  <th className="py-2 px-3">First Visited</th>
                  <th className="py-2 px-3">Expires At</th>
                  <th className="py-2 px-3 text-right">Admin Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono">
                {graceGrants.map((g) => (
                  <tr key={g.id}>
                    <td className="py-2 px-3 text-white font-semibold">{g.domain}</td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        g.status === 'GRACE_ACTIVE'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : g.status === 'BLOCKED'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      }`}>
                        {g.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-300">
                      {g.remainingSeconds > 0 ? `${Math.ceil(g.remainingSeconds / 60)} mins (${g.remainingSeconds}s)` : '0s (Expired)'}
                    </td>
                    <td className="py-2 px-3 text-slate-400">{g.firstVisitedAt ? new Date(g.firstVisitedAt).toLocaleTimeString() : '—'}</td>
                    <td className="py-2 px-3 text-slate-400">{g.expiresAt ? new Date(g.expiresAt).toLocaleTimeString() : '—'}</td>
                    <td className="py-2 px-3 text-right">
                      <Button
                        onClick={() => handleAdminReset(g.domain)}
                        disabled={busy}
                        className="text-[10px] py-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-sky-300"
                      >
                        Reset (+15m)
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Add Policy Form */}
        <Card title="Create Enterprise Access Policy">
          <form onSubmit={handleCreatePolicy} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Policy Rule Name</label>
              <input
                type="text"
                placeholder="e.g. Social Media Curfew"
                value={newPolicyName}
                onChange={(e) => setNewPolicyName(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Category</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-200"
              >
                <option value="social_media">Social Media</option>
                <option value="gaming">Gaming</option>
                <option value="streaming">Streaming & Video</option>
                <option value="entertainment">Entertainment</option>
                <option value="adult">Adult / Restricted</option>
                <option value="general">General / Other</option>
              </select>
            </div>

            {/* Strictness Control (Section 3: Min 0, Max 100, Step 1, Default 0) */}
            <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-slate-200">Website Strictness Score</span>
                <span className="font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 font-bold">
                  {newStrictness} / 100
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={newStrictness}
                onChange={(e) => setNewStrictness(Number(e.target.value))}
                className="w-full accent-sky-400 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
              />
              <p className="text-[11px] text-sky-200/90 font-medium">
                {getStrictnessLabel(newStrictness)}
              </p>
              <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                <span>0 (Least)</span>
                <span>25 (Low)</span>
                <span>50 (Moderate)</span>
                <span>75 (High)</span>
                <span>100 (Strictest)</span>
              </div>
            </div>

            {/* Configurable Website Access Workflow (Section 4) */}
            <div>
              <label className="text-xs text-slate-400 block mb-1">Access Enforcement Workflow</label>
              <select
                value={newAction}
                onChange={(e) => setNewAction(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-200"
              >
                <option value="temporary_access">Temporary Access (Countdown allowance &rarr; Block)</option>
                <option value="warn">Warning (Advisory alert logged, browsing continues)</option>
                <option value="block">Blocked (Immediate restriction & MV3 redirect)</option>
                <option value="allow">Allowed (Explicit whitelist exemption)</option>
              </select>
            </div>

            {newAction === 'temporary_access' && (
              <div>
                <label className="text-xs text-slate-400 block mb-1">Temporary Access Duration (Minutes)</label>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={newTempDuration}
                  onChange={(e) => setNewTempDuration(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-100 font-mono"
                  placeholder="Default: 15"
                />
              </div>
            )}

            <div>
              <label className="text-xs text-slate-400 block mb-1">Restricted Domains (comma-separated)</label>
              <input
                type="text"
                placeholder="domain1.com, domain2.com"
                value={newRestricted}
                onChange={(e) => setNewRestricted(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Daily Limit (Minutes)</label>
              <input
                type="number"
                min="5"
                max="720"
                value={newMaxMinutes}
                onChange={(e) => setNewMaxMinutes(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <Button type="submit" disabled={busy || !newPolicyName.trim()} className="w-full">
              Save Policy Rule
            </Button>
          </form>
        </Card>

        {/* Policies and Violations */}
        <div className="lg:col-span-2 space-y-6">
          <Card title={`Configured Policies (${policies.length})`}>
            {policiesLoading && !policiesData && <LoadingState label="Loading policies…" />}

            {policies.length > 0 && (
              <div className="space-y-3">
                {policies.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-lg border border-white/10 bg-white/[0.02] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1.5 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-semibold text-slate-100">{p.name}</h4>
                        <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-white/5 text-slate-300">
                          {p.category}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20 font-bold">
                          Strictness: {p.strictness ?? 0}/100
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                          p.action === 'block'
                            ? 'bg-rose-500/10 text-rose-300 border border-rose-500/20'
                            : p.action === 'temporary_access'
                            ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                            : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                        }`}>
                          {p.action || 'warn'}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                          p.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-400'
                        }`}>
                          {p.active ? 'ACTIVE' : 'DISABLED'}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400">
                        Daily Limit: {p.maxMinutesPerDay}m &bull; Temp Access Allowance: {p.temporaryAccessMinutes || 15}m
                      </p>

                      {p.restrictedDomains?.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {p.restrictedDomains.map((d) => (
                            <span key={d} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20">
                              {d}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                      {p.strictness > 0 && (
                        <button
                          onClick={() => handleResetStrictness(p.id)}
                          className="text-[11px] font-mono px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 border border-white/5 transition"
                          title="Reset strictness to 0"
                        >
                          Reset Strictness
                        </button>
                      )}
                      <Button onClick={() => handleTogglePolicy(p)} className="text-xs">
                        {p.active ? 'Disable' : 'Enable'}
                      </Button>
                      <button
                        onClick={() => handleDeletePolicy(p.id)}
                        className="text-slate-500 hover:text-rose-400 text-xs px-2 transition"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Policy Violations Feed */}
          <Card title={`Policy Advisory & Violation Feed (${violations.length})`}>
            {violationsLoading && !violationsData && <LoadingState label="Loading violations…" />}

            {violations.length === 0 && (
              <EmptyState title="No policy violations recorded">
                Household browsing complies with all configured rules.
              </EmptyState>
            )}

            {violations.length > 0 && (
              <div className="space-y-2">
                {violations.map((v) => (
                  <div
                    key={v.id}
                    className={`rounded-lg border p-3 flex items-center justify-between gap-3 text-xs ${
                      v.acknowledged
                        ? 'border-white/5 bg-white/[0.01] opacity-60'
                        : 'border-amber-500/30 bg-amber-500/5'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200">{v.policyName}</span>
                        <span className="font-mono text-purple-300 font-bold">{v.target}</span>
                        <span className="text-[10px] text-slate-500">{new Date(v.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-slate-400 mt-0.5">{v.warningMessage}</p>
                    </div>

                    {!v.acknowledged ? (
                      <Button onClick={() => handleAcknowledge(v.id)} className="text-xs shrink-0">
                        Acknowledge
                      </Button>
                    ) : (
                      <span className="text-slate-500 text-[11px] shrink-0">Acknowledged</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
