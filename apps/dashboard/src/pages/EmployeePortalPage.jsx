import { useCallback } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Card, PageHeader } from '../components/ui/Card.jsx';
import { ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

export default function EmployeePortalPage() {
  const fetchProfile = useCallback(async (opts) => {
    const me = await api.me(opts);
    const user = me?.user || me;
    const [employee, devices, monitoring] = await Promise.all([
      api.employee(user.id, opts),
      api.devices(opts),
      api.myMonitoringStatus(opts),
    ]);
    return { user, profile: employee?.employee, devices: devices?.devices || [], monitoring };
  }, []);
  const { data, error, loading, reload } = useApi(fetchProfile, { intervalMs: 30000 });

  if (loading && !data) return <LoadingState label="Loading your employee portal..." />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const profile = data?.profile;
  const device = data?.devices?.find((entry) => !entry.isRevoked);
  const analytics = profile?.analytics;
  const hasActivity = Boolean(analytics?.hasData);
  const monitoring = data?.monitoring?.monitoring;
  const monitoringLabel = monitoring?.allowed
    ? 'Active'
    : monitoring?.reason
      ? `Paused: ${formatMonitoringReason(monitoring.reason)}`
      : profile?.monitoringStatus === 'WAITING_FOR_EVENTS'
        ? 'Waiting for events'
        : 'Not started';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good morning, ${data?.user?.displayName || 'Employee'}!`}
        description="Your workspace, activity, devices, and privacy controls."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Active time"><p className="text-2xl font-bold text-emerald-400">{hasActivity ? formatDuration(analytics.activeSeconds) : 'No data available'}</p></Card>
        <Card title="Idle time"><p className="text-2xl font-bold text-amber-400">{hasActivity ? formatDuration(analytics.idleSeconds) : 'No data available'}</p></Card>
        <Card title="Account">
          <p className="text-lg font-semibold text-sky-300">{profile?.accountStatus || 'ACTIVE'}</p>
          <p className="mt-1 text-xs text-slate-400">{data?.user?.email}</p>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="My device">
          {device ? (
            <div className="space-y-2 text-sm">
              <p className="font-semibold text-white">{device.name || 'Windows PC'}</p>
              <p className="text-slate-400">{device.platform} · {device.status === 'online' ? 'Connected' : 'Offline'}</p>
              <p className="text-xs text-slate-500">Last heartbeat: {profile?.lastHeartbeatAt ? new Date(profile.lastHeartbeatAt).toLocaleString() : '—'}</p>
            </div>
          ) : (
            <div>
              <p className="text-sm text-amber-300">No device is connected yet.</p>
              <Link className="mt-3 inline-flex rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white" to="/employee-setup">Start device setup</Link>
            </div>
          )}
        </Card>
        <Card title="Monitoring status">
          <p className={`text-sm font-semibold ${monitoring?.allowed ? 'text-emerald-300' : 'text-amber-300'}`}>{monitoringLabel}</p>
          <p className="mt-1 text-xs text-slate-500">Enrollment status: {profile?.enrollmentStatus === 'ENROLLED' ? 'Enrolled' : 'Pending'}</p>
          {monitoring?.allowedUntil && <p className="mt-1 text-xs text-slate-500">Collecting until: {new Date(monitoring.allowedUntil).toLocaleString()}</p>}
          {!monitoring?.allowed && monitoring?.nextCheckAt && <p className="mt-1 text-xs text-slate-500">Next scheduled start: {new Date(monitoring.nextCheckAt).toLocaleString()}</p>}
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[
          ['App usage', analytics?.applicationUsage],
          ['Website usage', analytics?.websiteUsage],
        ].map(([title, entries]) => (
          <Card key={title} title={title}>
            {!hasActivity || !entries?.length ? <p className="text-sm text-slate-500">No data available</p> : (
              <ul className="space-y-2">{entries.map((entry) => <li key={entry.name} className="flex justify-between text-sm text-slate-300"><span>{entry.name}</span><span>{formatDuration(entry.seconds)}</span></li>)}</ul>
            )}
          </Card>
        ))}
      </div>
      <Card title="My account & privacy">
        <ul className="space-y-2 text-sm text-slate-300">
          <li>Profile: {data?.user?.displayName}</li>
          <li>Role: Employee</li>
          <li>Administrator authorization: {profile?.monitoringAuthorized ? 'Granted' : 'Not granted'}</li>
          <li>Your monitoring consent: {profile?.monitoringConsentGranted ? 'Granted' : 'Not granted'}</li>
          <li>Activity visibility: limited to your own authorized records</li>
        </ul>
      </Card>
    </div>
  );
}

function formatMonitoringReason(reason) {
  return ({
    USER_CONSENT_REQUIRED: 'consent is required',
    ADMIN_AUTHORIZATION_REQUIRED: 'administrator authorization is required',
    ORGANIZATION_TIMEZONE_REQUIRED: 'organization timezone is not configured',
    SCHEDULE_NOT_CONFIGURED: 'work schedule is not configured',
    OUTSIDE_SCHEDULE: 'outside scheduled work hours',
    ACCOUNT_INACTIVE: 'account is inactive',
    DEVICE_NOT_ENROLLED: 'device is not enrolled',
  }[reason] || 'authorization could not be verified');
}
