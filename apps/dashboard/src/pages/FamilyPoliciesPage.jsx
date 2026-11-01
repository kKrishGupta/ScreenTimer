import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { ShieldIcon } from '../components/ui/icons.jsx';

export default function FamilyPoliciesPage() {
  const fetchPolicies = useCallback((opts) => api.policies(opts), []);
  const fetchViolations = useCallback((opts) => api.policyViolations(opts), []);

  const { data: policiesData, error: policiesErr, loading: policiesLoading, reload: reloadPolicies } = useApi(fetchPolicies, { intervalMs: 5000 });
  const { data: violationsData, error: violationsErr, loading: violationsLoading, reload: reloadViolations } = useApi(fetchViolations, { intervalMs: 5000 });

  const [newPolicyName, setNewPolicyName] = useState('');
  const [newCategory, setNewCategory] = useState('social_media');
  const [newRestricted, setNewRestricted] = useState('reddit.com, twitter.com');
  const [newMaxMinutes, setNewMaxMinutes] = useState(45);
  const [simDomain, setSimDomain] = useState('tiktok.com');
  const [simResult, setSimResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const policies = policiesData?.policies ?? [];
  const violations = violationsData?.violations ?? [];

  const handleCreatePolicy = async (e) => {
    e.preventDefault();
    if (!newPolicyName.trim()) return;
    try {
      setBusy(true);
      const restrictedDomains = newRestricted.split(',').map((d) => d.trim()).filter(Boolean);
      await api.createPolicy({
        name: newPolicyName.trim(),
        category: newCategory,
        restrictedDomains,
        maxMinutesPerDay: Number(newMaxMinutes),
        action: 'warn',
        active: true,
      });
      setNewPolicyName('');
      reloadPolicies();
    } catch (err) {
      alert(`Error creating policy: ${err.message}`);
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

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Family Policies & Safety Controls"
          description="Age-appropriate category limits, restricted domains, soft warning workflows, and policy violations."
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
          <div className={`mt-4 rounded-lg p-3 text-xs border ${
            simResult.restricted
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          }`}>
            <span className="font-bold">{simResult.restricted ? 'POLICY ADVISORY ISSUED: ' : 'ACCESS PERMITTED: '}</span>
            <span>{simResult.restricted ? simResult.warningMessage : `Domain "${simDomain}" complies with all active family policies.`}</span>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Add Policy Form */}
        <Card title="Create Family Policy">
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
              </select>
            </div>

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

            <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 text-xs text-slate-400">
              <span className="font-semibold text-slate-200">Enforcement Model: </span>
              In Stage 1, policies issue visible warnings and notification events first rather than silent network blocking.
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
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-slate-100">{p.name}</h4>
                        <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-white/5 text-slate-300">
                          {p.category}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                          p.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-400'
                        }`}>
                          {p.active ? 'ACTIVE' : 'DISABLED'}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400">
                        Daily Limit: {p.maxMinutesPerDay}m &bull; Action: <strong className="text-amber-300 uppercase">{p.action}</strong>
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

                    <div className="flex items-center gap-2">
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
