import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { ErrorState, LoadingState } from '../components/ui/States.jsx';

const WINDOWS_PACKAGE_URL = '/downloads/digitalpulse-windows-agent.zip';
const CHROME_PACKAGE_URL = '/downloads/digitalpulse-chrome-extension.zip';
const EDGE_PACKAGE_URL = '/downloads/digitalpulse-edge-extension.zip';

const PACKAGE_FILE_NAMES = {
  windows: 'digitalpulse-windows-agent.zip',
  chrome: 'digitalpulse-chrome-extension.zip',
  edge: 'digitalpulse-edge-extension.zip',
};

const SHA256_LINE = /^[a-f0-9]{64}(?:\s+\*?[^\s]+)?\s*$/i;

function deviceBackendUrl() {
  const configured = String(import.meta.env.VITE_DEVICE_BACKEND_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  if (['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) return 'http://127.0.0.1:3001';
  return window.location.origin;
}

async function checkPublishedPackage(url, signal) {
  // CDNs do not consistently support HEAD or expose Content-Length. The small
  // checksum sidecar is the portable check; HEAD protects against SPA HTML.
  const checksumRequest = fetch(`${url}.sha256`, {
    headers: { Accept: 'text/plain' },
    signal,
    cache: 'no-store',
  }).then(async (response) => {
    if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) return false;
    return SHA256_LINE.test((await response.text()).trim());
  }).catch(() => false);

  const packageRequest = fetch(url, {
    method: 'HEAD',
    signal,
    cache: 'no-store',
  }).then((response) => {
    if (!response.ok) return false;
    return !/text\/html|application\/json/i.test(response.headers.get('content-type') || '');
  }).catch(() => false);

  const [checksumExists, packageExists] = await Promise.all([checksumRequest, packageRequest]);
  if (checksumExists && packageExists) return 'available';
  if (checksumExists || packageExists) return 'unverified';
  return 'unavailable';
}

function monitoringMessage(reason) {
  return ({
    USER_CONSENT_REQUIRED: 'Your consent is required.',
    ADMIN_AUTHORIZATION_REQUIRED: 'Administrator authorization is required.',
    ORGANIZATION_TIMEZONE_REQUIRED: 'Your administrator must configure the organization time zone.',
    SCHEDULE_NOT_CONFIGURED: 'A valid work schedule is required.',
    OUTSIDE_SCHEDULE: 'Monitoring is paused outside your working hours.',
    ACCOUNT_INACTIVE: 'Your account is inactive.',
  }[reason] || 'Monitoring authorization could not be confirmed.');
}

function normalize(value) {
  return String(value || '').toLowerCase().replaceAll('-', '_');
}

function browserName(device) {
  const browser = normalize(device?.browser);
  if (browser === 'chrome' || browser === 'edge') return browser;
  const name = normalize(device?.name);
  if (name.includes('edge')) return 'edge';
  if (name.includes('chrome')) return 'chrome';
  return '';
}

function findDevice(devices, kind, browser = '') {
  return devices
    .filter((device) => normalize(device.kind) === kind && (!browser || browserName(device) === browser))
    .sort((a, b) => new Date(b.lastSeenAt || b.createdAt || 0) - new Date(a.lastSeenAt || a.createdAt || 0))[0] || null;
}

function statusFor(device, installStarted) {
  if (device?.isRevoked || device?.status === 'revoked') return 'Revoked';
  if (device?.status === 'online' && device.lastSeenAt) return 'Connected';
  if (device?.lastSeenAt) return 'Offline';
  if (device) return 'Connection Pending';
  return installStarted ? 'Installation Pending' : 'Not Installed';
}

function readInstallState(userId) {
  try {
    return JSON.parse(localStorage.getItem(`dp_install_started_${userId || 'current'}`) || '{}');
  } catch {
    return {};
  }
}

function DeviceStatus({ title, device, installStarted }) {
  const status = statusFor(device, installStarted);
  const detail = status === 'Not Installed'
    ? 'No backend enrollment is registered. An installed but unenrolled app cannot be detected from this page.'
    : status === 'Installation Pending'
      ? 'You marked setup as started on this browser. The backend has not registered a device yet.'
      : status === 'Connection Pending'
        ? 'The backend has registered this device. A valid heartbeat is still required before it is shown as connected.'
        : status === 'Connected'
          ? 'The backend has received a valid device-authenticated heartbeat.'
          : status === 'Offline'
            ? 'The device was enrolled and sent a heartbeat before, but its latest heartbeat is stale.'
            : 'This device was revoked by an administrator.';

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-white">{title}</p>
        <span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-200" data-testid={`device-status-${title.toLowerCase().replaceAll(' ', '-')}`}>{status}</span>
      </div>
      <p className="mt-2 text-xs text-slate-400">{detail}</p>
      <dl className="mt-3 space-y-1 text-xs text-slate-400">
        <div className="flex justify-between gap-2"><dt>Installation</dt><dd>{device ? 'Collector registered' : installStarted ? 'Started locally' : 'Not verified'}</dd></div>
        <div className="flex justify-between gap-2"><dt>Enrollment</dt><dd>{device?.isRevoked || device?.status === 'revoked' ? 'Revoked' : device ? 'Enrolled' : 'Pending'}</dd></div>
        <div className="flex justify-between gap-2"><dt>Monitoring authorization</dt><dd>{status === 'Connected' && device?.monitoring?.allowed === true && Date.parse(device.monitoring.allowedUntil || '') > Date.now() ? 'Authorized' : 'Paused'}</dd></div>
      </dl>
      {device?.name && <p className="mt-2 text-xs text-slate-400">Registered device: {device.name}</p>}
      <p className="mt-1 text-xs text-slate-500">Last heartbeat: {device?.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '—'}</p>
      <p className="text-xs text-slate-500">Last successful sync: {device?.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : '—'}</p>
    </div>
  );
}

function InstallationCard({ title, packageUrl, packageState, fileName, onStarted, instructionsId, platform }) {
  const checking = packageState === 'checking';
  const verified = packageState === 'available';
  const unavailable = packageState === 'unavailable';

  return (
    <Card title={title}>
      <p className="text-sm text-slate-400">Download the independent {platform} package, extract it, then follow its README. Installation and enrollment do not enable monitoring.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a
          className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-white ${unavailable ? 'bg-amber-700 hover:bg-amber-600' : 'bg-sky-600 hover:bg-sky-500'}`}
          href={packageUrl}
          download={fileName}
          onClick={onStarted}
        >
          {checking ? `${title} (checking…)` : unavailable ? `Try ${title} download` : title}
        </a>
        <a className="inline-flex items-center rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5" href={`#${instructionsId}`}>Read installation instructions</a>
      </div>
      {packageState === 'unverified' && <p className="mt-3 text-xs text-amber-200">The download exists, but this browser could not complete every verification check. Download it and compare the published SHA-256 checksum.</p>}
      {unavailable && <p className="mt-3 text-xs text-amber-200">Automatic verification failed. You can still try the direct download. If it opens a web page instead of downloading a ZIP, ask your administrator to republish the employee packages.</p>}
      {verified && <p className="mt-3 text-xs text-emerald-300">Package and published checksum are available.</p>}
      {!checking && <a href={`${packageUrl}.sha256`} download={`${fileName}.sha256`} className="mt-3 block text-xs text-sky-400 underline">Download {platform} SHA-256 checksum</a>}
      <button type="button" onClick={onStarted} className="mt-3 block text-xs text-slate-400 underline decoration-slate-600 underline-offset-2">I have started installation</button>
    </Card>
  );
}

export default function EmployeeSetupPage() {
  const { user } = useAuth();
  const fetchDevices = useCallback(async (opts) => {
    const result = await api.devices(opts);
    return (result?.devices || []).filter((device) => device.userId === user?.id || (user?.role === 'EMPLOYEE' && !device.userId));
  }, [user?.id, user?.role]);
  const { data: devices = [], error, loading, reload } = useApi(fetchDevices, { intervalMs: 5000 });
  const fetchMonitoring = useCallback((opts) => api.myMonitoringStatus(opts), []);
  const { data: monitoringData, error: monitoringError, loading: monitoringLoading, reload: reloadMonitoring } = useApi(fetchMonitoring, { intervalMs: 5000 });
  const [packageAvailability, setPackageAvailability] = useState({ windows: 'checking', chrome: 'checking', edge: 'checking' });
  const [packageCheck, setPackageCheck] = useState(0);
  const [installStarted, setInstallStarted] = useState(() => readInstallState(user?.id));
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const isEmployee = user?.role === 'EMPLOYEE';
  const canEnroll = isEmployee || user?.role === 'ADMIN';
  const [deviceKind, setDeviceKind] = useState('DESKTOP_AGENT');
  const [tokens, setTokens] = useState({});
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const actionInFlight = useRef(false);
  const [now, setNow] = useState(Date.now());
  const issuedToken = tokens[deviceKind];
  const tokenActive = issuedToken && Date.parse(issuedToken.expiresAt) > now;
  const settings = !monitoringError && monitoringData?.settings;
  const gate = !monitoringError && monitoringData?.monitoring;
  const monitoringAuthorized = gate?.allowed === true && Date.parse(gate.allowedUntil || '') > now;
  const backendUrl = deviceBackendUrl();
  const remoteBackend = !/^http:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?$/i.test(backendUrl);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setInstallStarted(readInstallState(user?.id));
    setTokens({});
  }, [user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setPackageAvailability({ windows: 'checking', chrome: 'checking', edge: 'checking' });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    Promise.all([
      checkPublishedPackage(WINDOWS_PACKAGE_URL, signal),
      checkPublishedPackage(CHROME_PACKAGE_URL, signal),
      checkPublishedPackage(EDGE_PACKAGE_URL, signal),
    ])
      .then(([windows, chrome, edge]) => { if (!controller.signal.aborted) setPackageAvailability({ windows, chrome, edge }); });
    return () => controller.abort();
  }, [packageCheck]);

  async function updateConsent(consent) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy('consent'); setFeedback('');
    try {
      await api.setMyMonitoringConsent(consent);
      await reloadMonitoring();
      setFeedback(consent ? 'Your monitoring consent was recorded.' : 'Your consent was revoked. Monitoring will pause.');
    } catch (err) { setFeedback(err.message || 'Your consent could not be saved.'); }
    finally { actionInFlight.current = false; setBusy(''); }
  }

  async function createToken() {
    if (actionInFlight.current || tokenActive) return;
    actionInFlight.current = true;
    setBusy('token'); setFeedback('');
    try {
      const result = await api.createMyEnrollmentToken(deviceKind);
      if (!result.token || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('The server did not return a valid enrollment token.');
      setTokens((current) => ({ ...current, [deviceKind]: { token: result.token, expiresAt: result.expiresAt } }));
      setNow(Date.now());
      setFeedback('One-time token created. It is shown only in this page session.');
    } catch (err) { setFeedback(err.message || 'An enrollment token could not be created.'); }
    finally { actionInFlight.current = false; setBusy(''); }
  }

  async function copyToken() {
    if (!tokenActive) return;
    try { await navigator.clipboard.writeText(issuedToken.token); setFeedback('Enrollment token copied.'); }
    catch { setFeedback('Clipboard access failed. Select and copy the token below.'); }
  }

  const activeDevices = useMemo(() => devices || [], [devices]);
  const agentDevice = findDevice(activeDevices, 'desktop_agent');
  const chromeDevice = findDevice(activeDevices, 'browser_extension', 'chrome');
  const edgeDevice = findDevice(activeDevices, 'browser_extension', 'edge');

  function markInstallStarted(platform) {
    setInstallStarted((current) => {
      const updated = { ...current, [platform]: true };
      try {
        localStorage.setItem(`dp_install_started_${user?.id || 'current'}`, JSON.stringify(updated));
      } catch {
        // The local status is optional; backend device status remains authoritative.
      }
      return updated;
    });
  }

  async function checkStatus() {
    setLastCheckedAt(new Date());
    await reload();
    await reloadMonitoring();
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Set up DigitalPulse on your device" description="Install instructions and verified device status for your account." />

      <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100">
        <p className="font-semibold">LOCAL DEVELOPMENT / INTERNAL TEST BUILD</p>
        <p className="mt-1 text-amber-100/80">The default backend is http://127.0.0.1:3001 and must run on this computer. Employees on separate computers need an administrator-provided HTTPS deployment.</p>
      </div>

      <Card title="Connection target for this installation">
        <p className="text-sm text-slate-300">Use this exact backend origin when enrolling the downloaded agent or extension:</p>
        <code className="mt-2 block overflow-x-auto rounded-lg border border-white/10 bg-surface-950 p-3 text-xs text-sky-300">{backendUrl}</code>
        <p className="mt-2 text-xs text-slate-400">This value comes from the approved dashboard deployment{remoteBackend ? '. The Windows agent must explicitly allow its HTTPS remote backend in the terminal session.' : ' and points to the backend on this computer.'}</p>
      </Card>

      <Card title="What DigitalPulse collects">
        <p className="text-sm leading-6 text-slate-300">When the Windows agent is installed, enrolled, and running, it records foreground application names, active and idle intervals, and device heartbeats. When the browser extension is installed, enrolled, and running, it records foreground website domains and their active durations.</p>
        <p className="mt-2 text-sm text-slate-400">DigitalPulse does not collect keystrokes, passwords, page contents, private messages, clipboard contents, or credentials. Time while the device is locked, idle, or offline is not counted as active work.</p>
        <p className="mt-2 text-sm text-slate-400">Collection requires your consent, administrator authorization, an active account, and a valid work schedule in your organization time zone. Installing or enrolling a device does not grant any of these permissions. Screenshots and live screen viewing are not part of this setup.</p>
        {monitoringError ? <ErrorState error={monitoringError} onRetry={reloadMonitoring} /> : monitoringLoading ? <LoadingState label="Checking monitoring settings…" /> : (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-slate-300">Consent: {settings?.consentGranted ? 'Granted' : 'Not granted'} · Administrator approval: {settings?.adminAuthorized ? 'Authorized' : 'Pending'}</p>
            <p className="text-sm text-slate-300">Monitoring: {monitoringAuthorized ? 'Authorized during the current shift' : 'Paused'}. {!monitoringAuthorized && monitoringMessage(gate?.reason)}</p>
            {monitoringAuthorized && <p className="text-xs text-slate-400">Authorized until {new Date(gate.allowedUntil).toLocaleString()}. Activity still requires a connected collector.</p>}
            <Button disabled={Boolean(busy) || !settings} onClick={() => updateConsent(!settings?.consentGranted)}>{busy === 'consent' ? 'Saving consent…' : settings?.consentGranted ? 'Revoke monitoring consent' : 'I agree to the disclosed monitoring'}</Button>
            <Link to="/devices" className="ml-3 text-sm text-sky-400 underline">Review schedule and monitoring settings</Link>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <InstallationCard title="Install Windows Agent" platform="Windows" fileName={PACKAGE_FILE_NAMES.windows} packageUrl={WINDOWS_PACKAGE_URL} packageState={packageAvailability.windows} onStarted={() => markInstallStarted('windows')} instructionsId="windows-installation-instructions" />
        <InstallationCard title="Install Chrome Extension" platform="Chrome" fileName={PACKAGE_FILE_NAMES.chrome} packageUrl={CHROME_PACKAGE_URL} packageState={packageAvailability.chrome} onStarted={() => markInstallStarted('chrome')} instructionsId="chrome-installation-instructions" />
        <InstallationCard title="Install Edge Extension" platform="Edge" fileName={PACKAGE_FILE_NAMES.edge} packageUrl={EDGE_PACKAGE_URL} packageState={packageAvailability.edge} onStarted={() => markInstallStarted('edge')} instructionsId="edge-installation-instructions" />
      </div>
      <Button onClick={() => setPackageCheck((current) => current + 1)}>Recheck downloads</Button>

      {canEnroll && <Card title="Enroll your device">
        <p className="text-sm text-slate-400">Generate a token for your own account and organization. Each token expires after four hours and can be used once. Enroll Chrome and Edge separately with different browser tokens. Never share a token or paste a device secret here.</p>
        <label className="mt-4 block text-sm text-slate-300">Device type
          <select value={deviceKind} disabled={Boolean(busy)} onChange={(event) => { setDeviceKind(event.target.value); setFeedback(''); }} className="mt-1 block w-full rounded-lg border border-white/10 bg-surface-950 p-2 text-white sm:w-auto">
            <option value="DESKTOP_AGENT">Windows desktop agent</option>
            <option value="BROWSER_EXTENSION">Browser extension</option>
          </select>
        </label>
        <Button onClick={createToken} disabled={Boolean(busy) || Boolean(tokenActive)} className="mt-3">{busy === 'token' ? 'Generating…' : 'Generate one-time enrollment token'}</Button>
        {issuedToken && <div className="mt-4 rounded-lg border border-white/10 p-3">
          <label className="block text-sm text-slate-300">One-time enrollment token<input value={tokenActive ? issuedToken.token : 'Expired — generate a new token'} readOnly autoComplete="off" className="mt-1 w-full rounded bg-surface-950 p-2 font-mono text-xs text-white" /></label>
          <p className="mt-2 text-xs text-slate-400">Expires {new Date(issuedToken.expiresAt).toLocaleString()}. Single use; this page does not store it between visits.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button disabled={!tokenActive} onClick={copyToken}>Copy enrollment token</Button><Button disabled={Boolean(busy)} onClick={() => { setTokens((current) => ({ ...current, [deviceKind]: null })); setFeedback('Previous token hidden. It remains valid until consumed or expired. Generate a separate token only for another installation.'); }}>Prepare another device</Button></div>
        </div>}
        <p className="mt-3 text-xs text-slate-400">Enrollment registers identity. A valid heartbeat confirms connection. Monitoring requires separate server authorization and consent.</p>
      </Card>}
      {feedback && <p role="status" className="rounded-lg border border-white/10 p-3 text-sm text-slate-200">{feedback}</p>}

      <Card title="Read installation instructions">
        <div className="space-y-5 text-sm text-slate-300">
          <section id="windows-installation-instructions" className="scroll-mt-4">
            <h3 className="font-semibold text-white">Windows Agent</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Download the approved Windows package when it is available and unzip it.</li>
              <li>Open PowerShell in the extracted <code>digitalpulse-windows-agent</code> folder. Follow <code>README.txt</code> to enroll using your Windows token.</li>
              {remoteBackend && <li>In that PowerShell window, run <code>$env:DP_ALLOW_REMOTE_BACKEND='true'</code>. Then enroll with <code>--server {backendUrl}</code>. Keep this setting in the terminal session when starting the agent.</li>}
              {!remoteBackend && <li>Enroll with <code>--server {backendUrl}</code>.</li>}
              <li>Run <code>.\dp-user-agent.exe --status</code> for local status. Run the agent when ready to connect; it stays paused until the server authorizes collection.</li>
              <li>The activity buffer is stored in <code>%LOCALAPPDATA%\DigitalPulse</code>. Stop with Ctrl+C and retain this folder when upgrading.</li>
            </ol>
          </section>
          <section id="chrome-installation-instructions" className="scroll-mt-4">
            <h3 className="font-semibold text-white">Chrome Extension</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Download and extract the Chrome ZIP.</li>
              <li>Open <code>chrome://extensions</code>, enable Developer mode, select <span className="font-medium">Load unpacked</span>, and choose the extracted <code>digitalpulse-chrome-extension</code> folder containing <code>manifest.json</code>.</li>
              <li>Open the extension popup, expand <span className="font-medium">Backend settings</span>, save <code>{backendUrl}</code>, then paste your browser enrollment token.</li>
              <li>Pin DigitalPulse. Paste your browser token in the popup and select Enroll. Check its heartbeat and monitoring status separately.</li>
            </ol>
          </section>
          <section id="edge-installation-instructions" className="scroll-mt-4">
            <h3 className="font-semibold text-white">Edge Extension</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Download and extract the Edge ZIP.</li>
              <li>Open <code>edge://extensions</code>, enable Developer mode, select <span className="font-medium">Load unpacked</span>, and choose the extracted <code>digitalpulse-edge-extension</code> folder containing <code>manifest.json</code>.</li>
              <li>Open the extension popup, save <code>{backendUrl}</code> under <span className="font-medium">Backend settings</span>, then use the Edge-specific browser token.</li>
              <li>Pin DigitalPulse. Generate a separate browser token, paste it in the popup, and select Enroll. Chrome and Edge enroll independently.</li>
            </ol>
          </section>
        </div>
      </Card>

      <Card title="Installation and connection status">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-400">Backend device records refresh every five seconds. Status checks do not register or assign devices.</p>
          <Button onClick={checkStatus} className="bg-surface-800 text-white">Check installation status</Button>
        </div>
        {lastCheckedAt && <p className="mb-3 text-xs text-slate-500">Checked at {lastCheckedAt.toLocaleTimeString()}.</p>}
        {error ? <ErrorState error={error} onRetry={reload} /> : loading ? <LoadingState label="Checking backend device records…" /> : (
          <div className="grid gap-3 lg:grid-cols-3">
            <DeviceStatus title="Windows Agent" device={agentDevice} installStarted={installStarted.windows} />
            <DeviceStatus title="Chrome Extension" device={chromeDevice} installStarted={installStarted.chrome} />
            <DeviceStatus title="Edge Extension" device={edgeDevice} installStarted={installStarted.edge} />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">Connected appears only when a device has a valid authenticated heartbeat. An installation or locally reported setup start does not create a backend device or associate one with your account.</p>
      </Card>

      {!isEmployee && <p className="text-xs text-slate-500">This page shows device records for the signed-in account. Employees can return here after their invitation is accepted.</p>}
    </div>
  );
}
