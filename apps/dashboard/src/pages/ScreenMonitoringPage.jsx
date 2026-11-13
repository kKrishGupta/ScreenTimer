import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import LazyScreenshotImage from '../components/screenshots/LazyScreenshotImage.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const POLICY_REASONS = {
  DEVICE_NOT_ELIGIBLE: 'Device is revoked or is not an eligible Windows desktop agent.',
  DEVICE_OWNER_REQUIRED: 'Assign this device to an employee in this organization.',
  DEVICE_NOT_SELECTED: 'Select this device for screenshot monitoring.',
  SCREEN_MONITORING_DISABLED: 'Organization screenshot monitoring is disabled.',
  SCREEN_NOTICE_NOT_ACKNOWLEDGED: 'Employee screenshot notice acknowledgement is missing.',
  USER_CONSENT_REQUIRED: 'Employee monitoring consent is missing or withdrawn.',
  ADMIN_AUTHORIZATION_REQUIRED: 'Administrator monitoring authorization is missing.',
  ACCOUNT_INACTIVE: 'Employee account is inactive.',
  OUTSIDE_SCHEDULE: 'Outside the employee working schedule.',
  OUTSIDE_SCREEN_MONITORING_SCHEDULE: 'Outside the screenshot monitoring schedule.',
  ORGANIZATION_TIMEZONE_REQUIRED: 'Organization time zone must be configured.',
  SCHEDULE_NOT_CONFIGURED: 'Employee working schedule must be configured.',
};

export default function ScreenMonitoringPage() {
  const [employeeId, setEmployeeId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [captureSearch, setCaptureSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [formDraft, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const imageUrlCacheRef = useRef(new Map());
  const expiredRefreshesRef = useRef(new Set());

  const captureParams = useMemo(() => ({
    employeeId: employeeId || undefined,
    deviceId: deviceId || undefined,
    search: captureSearch.trim() || undefined,
    from: date ? `${date}T00:00:00.000Z` : undefined,
    to: date ? `${date}T23:59:59.999Z` : undefined,
    page,
    pageSize: 12,
  }), [employeeId, deviceId, captureSearch, date, page]);
  const loadSettings = useCallback((opts) => api.screenSettings({}, opts), []);
  const loadEmployees = useCallback((opts) => api.screenEmployees({}, opts), []);
  const loadCaptures = useCallback((opts) => {
    const normalize = (result) => {
      const cache = imageUrlCacheRef.current;
      const activeIds = new Set();
      const now = Date.now();
      const normalized = (result?.captures || []).map((capture) => {
        activeIds.add(capture.id);
        if (!capture.imageUrl) return capture;
        const cached = cache.get(capture.id);
        if (cached && cached.expiresAt - now > 60_000) {
          return cached.imageUrl === capture.imageUrl ? capture : { ...capture, imageUrl: cached.imageUrl };
        }
        const match = /[?&]expires=(\d+)/.exec(capture.imageUrl);
        cache.set(capture.id, {
          imageUrl: capture.imageUrl,
          expiresAt: match ? Number(match[1]) : now + 5 * 60_000,
        });
        return capture;
      });
      for (const id of cache.keys()) {
        if (!activeIds.has(id)) cache.delete(id);
      }
      return { ...result, captures: normalized };
    };
    const result = api.screenCaptures(captureParams, opts);
    return typeof result?.then === 'function' ? result.then(normalize) : normalize(result);
  }, [captureParams]);
  const settings = useApi(loadSettings, { queryKey: 'screen-settings', staleTimeMs: 5 * 60_000 });
  const employees = useApi(loadEmployees, { queryKey: 'screen-employees', staleTimeMs: 3 * 60_000 });
  const captures = useApi(loadCaptures, {
    queryKey: ['screen-captures', captureParams],
    staleTimeMs: 30_000,
    intervalMs: 60_000,
  });
  const reloadCaptures = captures.reload;

  const refreshExpiredImage = useCallback(async (captureId) => {
    if (expiredRefreshesRef.current.has(captureId)) return;
    expiredRefreshesRef.current.add(captureId);
    await reloadCaptures();
  }, [reloadCaptures]);

  const form = formDraft || (settings.data?.settings ? { ...settings.data.settings, excludedApplications: settings.data.settings.excludedApplications?.join(', ') || '' } : null);

  const visibleEmployees = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (employees.data?.employees || []).filter((row) => !query || row.employeeName.toLowerCase().includes(query) || row.deviceName.toLowerCase().includes(query));
  }, [employees.data, search]);
  const captureList = useMemo(() => captures.data?.captures || [], [captures.data]);
  const selectedIndex = selected ? captureList.findIndex((capture) => capture.id === selected.id) : -1;

  async function saveSettings(event) {
    event.preventDefault();
    setBusy(true); setNotice('');
    try {
      const result = await api.updateScreenSettings({ ...form, captureIntervalSeconds: Number(form.captureIntervalSeconds), retentionDays: Number(form.retentionDays), excludedApplications: form.excludedApplications.split(',').map((value) => value.trim()).filter(Boolean) });
      setForm({ ...result.settings, excludedApplications: result.settings.excludedApplications?.join(', ') || '' });
      setNotice('Screen monitoring policy saved. Enrolled agents will receive it on their next policy check.');
      await Promise.all([settings.reload(), employees.reload()]);
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  async function toggleDevice(row) {
    setBusy(true); setNotice('');
    try { await api.updateScreenDevice(row.deviceId, !row.selected); await employees.reload(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  async function deleteCapture(capture) {
    if (!window.confirm(`Permanently delete the ${new Date(capture.capturedAt).toLocaleString()} capture?`)) return;
    setBusy(true);
    try { await api.deleteScreenCapture(capture.id); setSelected(null); await captures.reload(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }

  if ((settings.loading && !settings.data) || (employees.loading && !employees.data)) return <LoadingState label="Loading screen monitoring policy..." />;
  if ((settings.error && !settings.data) || (employees.error && !employees.data)) return <ErrorState error={settings.error || employees.error} onRetry={() => { settings.reload(); employees.reload(); }} />;

  return (
    <div className="space-y-6">
      <PageHeader title="Screen Monitoring" description="Transparent, scheduled screenshots from selected enrolled Windows work devices." />
      <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-sky-100">
        Screenshots are captured only after employee acknowledgement, administrator authorization, device selection, and schedule checks. Every view and deletion is audited.
      </div>
      {notice && <div role="status" className="rounded-lg border border-white/10 bg-surface-900 px-4 py-3 text-sm text-slate-200">{notice}</div>}

      {form && <Card title="Organization policy">
        <form onSubmit={saveSettings} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm text-slate-300">Automatic capture
            <select value={String(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.value === 'true' })} className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2">
              <option value="false">Disabled</option><option value="true">Enabled</option>
            </select>
          </label>
          <label className="text-sm text-slate-300">Capture interval
            <select value={form.captureIntervalSeconds} onChange={(event) => setForm({ ...form, captureIntervalSeconds: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2">
              {[60, 300, 600, 900, 1800, 3600].map((seconds) => <option key={seconds} value={seconds}>Every {seconds / 60} minutes</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-300">Retention days
            <input type="number" min="1" max="365" value={form.retentionDays} onChange={(event) => setForm({ ...form, retentionDays: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2" />
          </label>
          <label className="text-sm text-slate-300">Excluded applications
            <input value={form.excludedApplications} onChange={(event) => setForm({ ...form, excludedApplications: event.target.value })} placeholder="1password.exe, keepass.exe" className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2" />
          </label>
          <label className="text-sm text-slate-300">Start time<input type="time" value={form.shiftStart} onChange={(event) => setForm({ ...form, shiftStart: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2" /></label>
          <label className="text-sm text-slate-300">End time<input type="time" value={form.shiftEnd} onChange={(event) => setForm({ ...form, shiftEnd: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2" /></label>
          <fieldset className="md:col-span-2 xl:col-span-2"><legend className="text-sm text-slate-300">Monitoring days</legend><div className="mt-2 flex flex-wrap gap-2">{DAYS.map((day) => <label key={day} className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300"><input type="checkbox" checked={form.workingDays.includes(day)} onChange={(event) => setForm({ ...form, workingDays: event.target.checked ? [...form.workingDays, day] : form.workingDays.filter((value) => value !== day) })} />{day}</label>)}</div></fieldset>
          <div className="md:col-span-2 xl:col-span-4"><Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save monitoring policy'}</Button></div>
        </form>
      </Card>}

      <Card title="Authorized employee devices">
        <div className="mb-4 flex flex-wrap gap-3"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employee or device" className="min-w-64 rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm" /></div>
        {visibleEmployees.length === 0 ? <EmptyState title={search ? 'No matching devices' : 'No eligible Windows devices'}>{search ? 'Try another employee or device name.' : <>
          <p>No Windows desktop agent enrolled</p>
          <p className="mt-1">
            No desktop-agent registration was found in this organization.
            Installing the application is not enrollment; use a Windows
            Desktop Agent enrollment token and verify its first heartbeat.
          </p>
        </>}</EmptyState> : <div className="grid gap-3 lg:grid-cols-2">{visibleEmployees.map((row) => <div key={row.deviceId} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-white">{row.employeeName}</p><p className="text-sm text-slate-400">{row.deviceName} · Windows Desktop Agent</p><p className="text-xs text-slate-400">{row.email}</p></div><Button disabled={busy || row.revoked || (!row.selected && (!row.employeeId || !row.acknowledgedAt))} onClick={() => toggleDevice(row)}>{row.selected ? 'Disable' : 'Authorize'}</Button></div>
          <p className="mt-2 text-sm text-amber-200">{row.revoked ? 'Device enrollment has been revoked.' : POLICY_REASONS[row.policyReason] || 'Screenshot authorization is unavailable.'}</p>
          <p className="mt-1 text-xs text-slate-400">Policy authorization: {row.policyAllowed ? 'authorized' : 'not authorized'} · Capture pipeline: {row.lastCaptureAt ? 'has a verified capture' : row.lastFailure ? `failed (${row.lastFailure})` : 'no verified capture yet'}</p>
          <p className="mt-2 text-xs text-slate-400">Last heartbeat: {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : 'Never received'}{row.connectivity === 'offline' ? ' · Agent is offline; check its connection and enrollment.' : ''}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs"><Status value={row.connectivity} /><Status value={row.acknowledgedAt ? 'notice acknowledged' : 'awaiting acknowledgement'} /><Status value={row.selected ? 'selected' : 'not selected'} /></div>
          <p className="mt-3 text-xs text-slate-500">Last verified capture record: {row.lastCaptureAt ? new Date(row.lastCaptureAt).toLocaleString() : 'None'}{row.selected && row.lastCaptureAt ? ` · Next expected: ${new Date(new Date(row.lastCaptureAt).getTime() + Number(form?.captureIntervalSeconds || 300) * 1000).toLocaleString()}` : ''}{row.lastFailure ? ` · Failure: ${row.lastFailure}` : ''}</p>
          {row.captureStatusMismatch && <p role="alert" className="mt-1 text-xs text-amber-300">The device capture status does not match stored screenshot records. Refresh or inspect backend logs.</p>}
        </div>)}</div>}
      </Card>

      <Card title="Screenshot gallery">
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input value={captureSearch} onChange={(event) => { setCaptureSearch(event.target.value); setPage(1); }} placeholder="Search employee" className="rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm" />
          <select value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm"><option value="">All employees</option>{[...new Map((employees.data?.employees || []).filter((row) => row.employeeId).map((row) => [row.employeeId, row])).values()].map((row) => <option key={row.employeeId} value={row.employeeId}>{row.employeeName}</option>)}</select>
          <select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm"><option value="">All devices</option>{(employees.data?.employees || []).map((row) => <option key={row.deviceId} value={row.deviceId}>{row.deviceName}</option>)}</select>
          <input type="date" value={date} onChange={(event) => { setDate(event.target.value); setPage(1); }} className="rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm" />
          <Button onClick={captures.reload}>Refresh gallery</Button>
        </div>
        {captures.loading && !captures.data ? <LoadingState label="Loading captures..." /> : captures.error && !captures.data ? <ErrorState error={captures.error} onRetry={captures.reload} /> : captureList.length === 0 ? <EmptyState title="No screenshots in this range">Captures appear here only after every authorization and schedule gate passes.</EmptyState> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{captureList.map((capture) => <button type="button" key={capture.id} onClick={() => setSelected(capture)} className="overflow-hidden rounded-xl border border-white/10 bg-surface-950 text-left hover:border-sky-400/40">
          <div className="aspect-video bg-slate-950"><LazyScreenshotImage capture={capture} onExpired={refreshExpiredImage} /></div>
          <div className="p-3"><p className="font-medium text-white">{capture.employeeName}</p><p className="text-xs text-slate-400">{capture.deviceName} · {capture.collectorKind === 'BROWSER_EXTENSION' ? `${capture.browser === 'edge' ? 'Edge' : 'Chrome'} Browser Extension` : 'Windows Desktop Agent'}</p><p className="mt-2 text-xs text-sky-300">{new Date(capture.capturedAt).toLocaleString()}</p></div>
        </button>)}</div>}
        {(captures.data?.totalPages || 0) > 1 && <div className="mt-4 flex items-center justify-center gap-3"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-sm text-slate-400">Page {page} of {captures.data.totalPages}</span><Button disabled={page >= captures.data.totalPages} onClick={() => setPage(page + 1)}>Next</Button></div>}
      </Card>

      {selected && <div className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Screenshot viewer"><div className="w-full max-w-6xl rounded-xl border border-white/10 bg-surface-900 p-4">
        <div className="mb-3 flex items-start justify-between"><div><p className="font-semibold text-white">{selected.employeeName} · {selected.deviceName}</p><p className="text-sm text-slate-400">Captured {new Date(selected.capturedAt).toLocaleString()} · {selected.width} × {selected.height}</p></div><button onClick={() => setSelected(null)} className="text-2xl text-slate-300" aria-label="Close viewer">×</button></div>
        <div className="flex h-[72vh] max-h-[72vh] justify-center bg-slate-950"><LazyScreenshotImage capture={selected} eager onExpired={refreshExpiredImage} /></div>
        <div className="mt-4 flex justify-between"><Button disabled={selectedIndex >= captureList.length - 1} onClick={() => setSelected(captureList[selectedIndex + 1])}>Previous</Button><Button disabled={busy} className="text-rose-300" onClick={() => deleteCapture(selected)}>Delete permanently</Button><Button disabled={selectedIndex <= 0} onClick={() => setSelected(captureList[selectedIndex - 1])}>Next</Button></div>
      </div></div>}
    </div>
  );
}

function Status({ value }) {
  const positive = ['online', 'notice acknowledged', 'selected'].includes(value);
  return <span className={`rounded-full px-2 py-1 ${positive ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{value}</span>;
}
