import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const roleIs = (role, ...values) => values.includes(String(role || '').toUpperCase());

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function reasonText(reason) {
  return ({
    EMPLOYEE_NOT_FOUND: 'The account assigned to this device could not be verified.',
    ACCOUNT_INACTIVE: 'Monitoring is paused because this account is inactive.',
    ADMIN_AUTHORIZATION_REQUIRED: 'An administrator has not authorized monitoring for this account.',
    USER_CONSENT_REQUIRED: 'Monitoring is paused until you give consent.',
    ORGANIZATION_TIMEZONE_REQUIRED: 'An administrator must configure the organization time zone.',
    SCHEDULE_NOT_CONFIGURED: 'Set working days and hours to enable scheduled monitoring.',
    OUTSIDE_SCHEDULE: 'Monitoring is paused outside your assigned working hours.',
  }[reason] || 'Monitoring is not authorized at this time.');
}

export default function DevicesPage() {
  const { user } = useAuth();
  const fetchDevices = useCallback((opts) => api.devices(opts), []);
  const fetchMonitoring = useCallback((opts) => api.myMonitoringStatus(opts), []);
  const { data, error, loading, reload } = useApi(fetchDevices, { intervalMs: 10000 });
  const { data: monitoringData, error: monitoringError, reload: reloadMonitoring } = useApi(fetchMonitoring, { intervalMs: 15000 });
  const [schedule, setSchedule] = useState({ shiftStart: '', shiftEnd: '', workingDays: [] });
  const [timezone, setTimezone] = useState('');
  const [kind, setKind] = useState('DESKTOP_AGENT');
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState('');
  const [issuedToken, setIssuedToken] = useState(null);
  const [copyMessage, setCopyMessage] = useState('');

  const devices = data?.devices ?? [];
  const status = monitoringData?.monitoring;
  const settings = monitoringData?.settings;
  const isEmployee = roleIs(user?.role, 'EMPLOYEE');
  const isOrgAdmin = roleIs(user?.role, 'ORGANIZATION_ADMIN', 'ORG_ADMIN');
  const canEnrollSelf = isEmployee || isOrgAdmin;

  useEffect(() => {
    if (!settings) return;
    setSchedule({
      shiftStart: settings.shiftStart || '',
      shiftEnd: settings.shiftEnd || '',
      workingDays: Array.isArray(settings.workingDays) ? settings.workingDays : [],
    });
    setTimezone(settings.organizationTimezone || '');
  }, [settings?.shiftStart, settings?.shiftEnd, settings?.workingDays?.join(','), settings?.organizationTimezone]);

  const refresh = () => { reload(); reloadMonitoring(); };
  const saveSchedule = async (event) => {
    event.preventDefault();
    setWorking('schedule'); setMessage('');
    try {
      await api.updateMyMonitoringSchedule(schedule);
      await reloadMonitoring();
      setMessage('Your schedule was saved.');
    } catch (err) { setMessage(err.message || 'The schedule could not be saved.'); }
    finally { setWorking(''); }
  };

  const saveTimezone = async (event) => {
    event.preventDefault();
    setWorking('timezone'); setMessage('');
    try {
      await api.updateOrganizationTimezone(timezone.trim());
      await reloadMonitoring();
      setMessage('Organization time zone was saved. Monitoring will still require valid consent and an active schedule.');
    } catch (err) { setMessage(err.message || 'Organization time zone could not be saved.'); }
    finally { setWorking(''); }
  };

  const updateOwnAuthorization = async (authorized) => {
    setWorking('authorization'); setMessage('');
    try {
      await api.setMyMonitoringAuthorization(authorized);
      await reloadMonitoring();
      setMessage(authorized ? 'Administrator authorization was recorded for your account.' : 'Administrator authorization was revoked. Monitoring will pause.');
    } catch (err) { setMessage(err.message || 'Administrator authorization could not be updated.'); }
    finally { setWorking(''); }
  };

  const updateConsent = async (consent) => {
    setWorking('consent'); setMessage('');
    try {
      await api.setMyMonitoringConsent(consent);
      await reloadMonitoring();
      setMessage(consent ? 'Your consent was recorded.' : 'Your consent was revoked. Monitoring will pause.');
    } catch (err) { setMessage(err.message || 'Consent could not be updated.'); }
    finally { setWorking(''); }
  };

  const createToken = async () => {
    setWorking('token'); setMessage(''); setIssuedToken(null);
    try {
      const result = await api.createMyEnrollmentToken(kind);
      setIssuedToken({ token: result.token, expiresAt: result.expiresAt, deviceKind: result.deviceKind });
      setMessage('One-time enrollment token created. It is shown only in this page session.');
    } catch (err) { setMessage(err.message || 'Enrollment token could not be created.'); }
    finally { setWorking(''); }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(issuedToken?.token || '');
      setCopyMessage('Enrollment token copied.');
    } catch {
      setCopyMessage('Clipboard access is unavailable. Select and copy the token manually.');
    }
    window.setTimeout(() => setCopyMessage(''), 3000);
  };

  if (loading && !data) return <LoadingState label="Loading device status…" />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader
          title={isEmployee ? 'My Devices' : 'Device Status'}
          description={isEmployee ? 'View your enrolled devices and control your monitoring consent.' : 'Review enrolled collectors and configure your own device monitoring.'}
        />
        <Button onClick={refresh} className="self-start">Refresh</Button>
      </div>

      {message && <p role="status" className="text-sm text-sky-200">{message}</p>}
      {monitoringError && <ErrorState error={monitoringError} onRetry={reloadMonitoring} />}

      <Card title="Your monitoring authorization">
        <p className={`text-sm font-semibold ${status?.allowed ? 'text-emerald-300' : 'text-amber-200'}`}>
          {status?.allowed ? 'Monitoring authorized for the current schedule window' : reasonText(status?.reason)}
        </p>
        {status?.allowedUntil && <p className="mt-1 text-xs text-slate-400">Monitoring pauses at {formatDate(status.allowedUntil)}.</p>}
        {settings && <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
          <p className="text-slate-400">Administrator authorization: <span className="text-slate-200">{settings.adminAuthorized ? 'Granted' : 'Not granted'}</span></p>
          <p className="text-slate-400">Your consent: <span className="text-slate-200">{settings.consentGranted ? 'Granted' : 'Not granted'}</span></p>
          <p className="text-slate-400">Organization time zone: <span className="text-slate-200">{settings.organizationTimezone || 'Not configured'}</span></p>
        </div>}
        {isOrgAdmin && <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-sm text-slate-300">Administrator authorization for your account: <span className="font-semibold text-white">{settings?.adminAuthorized ? 'Granted' : 'Not granted'}</span></p>
          <p className="mt-1 text-xs text-slate-500">This applies only to your own devices. Employee monitoring authorization is managed from the employee profile.</p>
          <Button className="mt-3" disabled={working === 'authorization'} onClick={() => updateOwnAuthorization(!settings?.adminAuthorized)}>
            {working === 'authorization' ? 'Saving…' : settings?.adminAuthorized ? 'Revoke administrator authorization' : 'Authorize monitoring for my account'}
          </Button>
        </div>}
        <p className="mt-3 text-xs leading-5 text-slate-400">DigitalPulse records foreground application names, website domains, and active or idle session timing only during the authorized work schedule. It does not record keystrokes, page contents, or clipboard data.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={working === 'consent' || settings?.consentGranted} onClick={() => updateConsent(true)}>
            {working === 'consent' ? 'Saving…' : 'Give monitoring consent'}
          </Button>
          <Button disabled={working === 'consent' || !settings?.consentGranted} onClick={() => updateConsent(false)}>
            Revoke consent
          </Button>
        </div>
      </Card>

      {settings && <Card title="Working schedule">
        <form onSubmit={saveSchedule} className="space-y-4">
          <p className="text-xs text-slate-400">Collection uses your organization time zone. Overnight shifts are supported. No activity is collected outside these hours.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">Start<input aria-label="Monitoring shift start" type="time" value={schedule.shiftStart} onChange={(e) => setSchedule((current) => ({ ...current, shiftStart: e.target.value }))} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
            <label className="text-xs text-slate-400">End<input aria-label="Monitoring shift end" type="time" value={schedule.shiftEnd} onChange={(e) => setSchedule((current) => ({ ...current, shiftEnd: e.target.value }))} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          </div>
          <div className="flex flex-wrap gap-2">{DAYS.map((day) => {
            const active = schedule.workingDays.includes(day);
            return <button key={day} type="button" aria-pressed={active} onClick={() => setSchedule((current) => ({ ...current, workingDays: active ? current.workingDays.filter((value) => value !== day) : [...current.workingDays, day] }))} className={`rounded-lg border px-3 py-1.5 text-xs ${active ? 'border-sky-400/50 bg-sky-400/10 text-sky-200' : 'border-white/10 text-slate-500'}`}>{day}</button>;
          })}</div>
          <Button type="submit" disabled={working === 'schedule'}>{working === 'schedule' ? 'Saving…' : 'Save my schedule'}</Button>
        </form>
      </Card>}

      {isOrgAdmin && <Card title="Organization time zone">
        <form onSubmit={saveTimezone} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs text-slate-400">IANA time zone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} required placeholder="Asia/Kolkata" className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          <Button type="submit" disabled={working === 'timezone'}>{working === 'timezone' ? 'Saving…' : 'Save time zone'}</Button>
        </form>
      </Card>}

      {canEnrollSelf && <Card title="Enroll your device">
        <p className="mb-3 text-sm text-slate-400">Create a short-lived, single-use token for a device assigned to your account. Enrollment does not activate monitoring until consent, authorization, and schedule checks pass.</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="text-xs text-slate-400">Collector<select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"><option value="DESKTOP_AGENT">Windows Agent</option><option value="BROWSER_EXTENSION">Chrome / Edge Extension</option></select></label>
          <Button disabled={working === 'token'} onClick={createToken}>{working === 'token' ? 'Creating…' : 'Create one-time enrollment token'}</Button>
        </div>
        {issuedToken && <div className="mt-4 space-y-2 rounded-lg border border-sky-400/20 bg-sky-400/5 p-3">
          <p className="text-sm font-medium text-sky-100">Token created · expires {formatDate(issuedToken.expiresAt)}</p>
          <div className="flex flex-col gap-2 sm:flex-row"><input aria-label="One-time enrollment token" readOnly value={issuedToken.token} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 font-mono text-xs text-white" /><Button onClick={copyToken}>Copy token</Button></div>
          <p role="status" className="text-xs text-slate-400">Keep this token private. It is shown once and cannot be recovered after leaving this page.</p>
          {copyMessage && <p role="status" className="text-xs text-emerald-300">{copyMessage}</p>}
        </div>}
      </Card>}

      <Card>
        {devices.length === 0 ? <EmptyState title="No enrolled devices">Devices appear after an authorized user enrolls a collector and it sends a valid heartbeat.</EmptyState> : (
          <div className="grid gap-4 sm:grid-cols-2">
            {devices.map((device) => <div key={device.id} className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-5">
              <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-100">{device.name}</h3><p className="mt-0.5 font-mono text-xs text-slate-400">{device.platform}</p></div><span className={`rounded-md px-2.5 py-1 text-xs font-medium ${device.status === 'online' ? 'bg-emerald-500/10 text-emerald-300' : device.status === 'revoked' ? 'bg-rose-500/10 text-rose-300' : 'bg-slate-500/10 text-slate-300'}`}>{device.status === 'online' ? 'Connected' : device.status === 'revoked' ? 'Revoked' : 'Offline'}</span></div>
              <p className="text-xs text-slate-400">{String(device.kind).toUpperCase() === 'DESKTOP_AGENT' ? 'Windows Desktop Agent' : `Browser Extension (${device.browser || 'Web'})`}{device.assignedUser?.displayName ? ` · ${device.assignedUser.displayName}` : ''}</p>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-white/5 pt-3 text-xs"><dt className="text-slate-500">Last heartbeat</dt><dd className="text-slate-300">{formatDate(device.lastSeenAt)}</dd><dt className="text-slate-500">Last sync</dt><dd className="text-slate-300">{formatDate(device.lastSyncAt)}</dd><dt className="text-slate-500">Monitoring</dt><dd className={device.monitoring?.allowed ? 'text-emerald-300' : 'text-amber-200'}>{device.monitoring?.allowed ? 'Authorized now' : reasonText(device.monitoring?.reason)}</dd></dl>
            </div>)}
          </div>
        )}
      </Card>
    </div>
  );
}
