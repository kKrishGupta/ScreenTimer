import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card } from './ui/Card.jsx';
import { ErrorState } from './ui/States.jsx';

export function parseBlockedDomains(value) {
  const entries = value.split(/[\s,]+/).filter(Boolean);
  if (!entries.length) throw new Error('Enter at least one website domain.');
  return [...new Set(entries.map((entry) => {
    let url;
    try { url = new URL(entry.includes('://') ? entry : `https://${entry}`); }
    catch { throw new Error(`Invalid website: ${entry}`); }
    const domain = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !domain.includes('.') || domain.length > 253 ||
        !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`Enter a valid website domain: ${entry}`);
    }
    return domain;
  }))];
}

export default function WebsiteBlockingControls() {
  const fetchPolicies = useCallback(opts => api.policies(opts), []);
  const { data, error, loading, reload } = useApi(fetchPolicies, { intervalMs: 10000 });
  const [domains, setDomains] = useState('');
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const policies = (data?.policies || []).filter(policy => policy.action === 'block' && policy.restrictedDomains?.length);

  async function save(event) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setSaveError(''); setMessage('');
    try {
      const restrictedDomains = parseBlockedDomains(domains);
      await api.createPolicy({ name: `Block ${restrictedDomains.join(', ')}`.slice(0, 100),
        category: 'custom', restrictedDomains, action: 'block', strictness: 100, active: true });
      setDomains('');
      setMessage('Blocking policy saved. Enrolled browser extensions apply it on their next policy sync.');
      await reload();
    } catch (err) { setSaveError(err.message || 'Unable to save website blocking.'); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function toggle(policy) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setSaveError(''); setMessage('');
    try {
      await api.updatePolicy(policy.id, { active: !policy.active });
      setMessage(`Blocking policy ${policy.active ? 'disabled' : 'enabled'}. Changes apply on the next extension policy sync.`);
      await reload();
    } catch (err) { setSaveError(err.message || 'Unable to update website blocking.'); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <Card title="Block websites for your organization">
    <p className="mb-4 text-sm text-slate-400">Applies to enrolled browser extensions across your organization, including employee devices. Enter domains or URLs; paths are removed and the entire domain is blocked. The extension must be installed and enrolled.</p>
    <form onSubmit={save} className="space-y-3">
      <label className="block text-sm text-slate-300">Websites to block
        <textarea required value={domains} onChange={event => setDomains(event.target.value)} disabled={busy} placeholder="youtube.com, facebook.com" className="mt-2 block w-full rounded-lg border border-white/10 bg-slate-950 p-3 text-white" />
      </label>
      <Button type="submit" disabled={busy || !domains.trim()}>{busy ? 'Saving…' : 'Block websites'}</Button>
      <Link to="/policies" className="ml-4 text-sm text-sky-400">Advanced policy settings</Link>
    </form>
    {saveError && <p role="alert" className="mt-3 text-sm text-rose-300">{saveError}</p>}
    {message && <p role="status" className="mt-3 text-sm text-emerald-300">{message}</p>}
    {error && <ErrorState error={error} onRetry={reload} />}
    <div className="mt-5 space-y-3">
      {loading && !data ? <p>Loading blocking policies…</p> : !error && policies.length === 0 ? <p className="text-sm text-slate-400">No website-blocking policies configured yet.</p> : null}
      {policies.map(policy => <div key={policy.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3">
        <div><p className="font-medium text-white">{policy.restrictedDomains.join(', ')}</p><p className="text-xs text-slate-400">{policy.active ? 'Enabled' : 'Disabled'} · Organization-wide</p></div>
        <Button disabled={busy} onClick={() => toggle(policy)}>{policy.active ? 'Disable blocking' : 'Enable blocking'}</Button>
      </div>)}
    </div>
  </Card>;
}
