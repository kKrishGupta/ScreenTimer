import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentStatus, SessionState } from './types';
import { nativeErrorMessage as errorMessage } from './native-error';

const emptyStatus: AgentStatus = {
  running: false, enrolled: false, deviceId: null, lifecycle: 'UNKNOWN', backendUrl: null,
  pendingQueue: 0, totalRecorded: 0, recoveryRequired: false, storageAvailable: false,
  statusDetail: 'Checking the local agent…'
};

function App() {
  const [status, setStatus] = useState<AgentStatus>(emptyStatus);
  const [session, setSession] = useState<SessionState>({ signedIn: false, email: null });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Monitoring remains stopped until every authorization gate passes.');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchOnLogin, setLaunchOnLogin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [next, currentSession, startup] = await Promise.all([
        invoke<AgentStatus>('agent_status'), invoke<SessionState>('session_state'), invoke<boolean>('get_launch_on_login')
      ]);
      setStatus(next); setSession(currentSession); setLaunchOnLogin(startup);
      await invoke('update_tray_status', { running: next.running, attention: next.recoveryRequired || !next.storageAvailable });
    } catch (error) { setMessage(errorMessage(error)); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('Signing in and verifying this device…');
    try {
      const result = await invoke<SessionState>('employee_login', { email, password, secretKey: status.enrolled ? '' : secretKey });
      setPassword(''); setSecretKey(''); setSession(result);
      setMessage('Device verified. Monitoring is still stopped until you explicitly start it.');
      await refresh();
    } catch (error) { setPassword(''); setSecretKey(''); setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const run = async (command: string, args: Record<string, unknown> = {}) => {
    setBusy(true);
    try { setMessage(await invoke<string>(command, args)); await refresh(); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const monitoringTone = status.running ? 'live' : status.recoveryRequired ? 'attention' : 'stopped';
  const connection = status.backendUrl?.startsWith('https://') ? 'Configured securely' : status.backendUrl ? 'Local backend' : 'Not configured';
  const canStart = session.signedIn && status.enrolled && status.storageAvailable && consent && !status.running;
  const deviceShort = status.deviceId ? `${status.deviceId.slice(0, 8)}…${status.deviceId.slice(-4)}` : 'Not enrolled';
  const policyLabel = status.running ? 'Agent revalidates continuously' : status.lifecycle === 'ACTIVE' ? 'Eligible; start required' : status.lifecycle;

  return <div className="shell">
    <aside>
      <div className="brand"><span className="mark">DP</span><div><strong>DigitalPulse</strong><small>Employee Control Center</small></div></div>
      <nav><button className="selected">Overview</button><button onClick={() => setSettingsOpen(!settingsOpen)}>Settings</button></nav>
      <div className="privacy"><span>● Visible monitoring</span><p>Collection is never enabled by opening this app. Server policy and your explicit action are required.</p></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">WORKSPACE STATUS</p><h1>Good to see you.</h1><p>Control authorized monitoring without keeping this window open.</p></div><div className={`status ${monitoringTone}`}><i />{status.running ? 'Monitoring active' : status.recoveryRequired ? 'Attention required' : 'Monitoring stopped'}</div></header>

      <section className="notice" role="status">{message}</section>

      {!session.signedIn && <section className="login card">
        <div><p className="eyebrow">EMPLOYEE ACCESS</p><h2>{status.enrolled ? 'Sign in to this enrolled device' : 'Sign in and enroll this device'}</h2><p>Credentials are sent directly to DigitalPulse over HTTPS. Secrets are not saved by the Control Center.</p></div>
        <form onSubmit={submitLogin}>
          <label>Employee email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          {!status.enrolled && <label>Employee Secret Key<input type="password" autoComplete="off" value={secretKey} onChange={e => setSecretKey(e.target.value)} required /></label>}
          <button className="primary" disabled={busy}>{busy ? 'Verifying…' : status.enrolled ? 'Sign in' : 'Sign in & enroll'}</button>
        </form>
      </section>}

      <section className="hero card">
        <div><p className="eyebrow">MONITORING CONTROL</p><h2>{status.running ? 'Your authorized work session is active' : 'Monitoring is currently off'}</h2><p>{status.running ? 'You may close this window. The user-session agent continues and remains subject to policy.' : 'Starting requests monitoring; the agent will collect only if consent, administrator approval, and schedule checks pass.'}</p></div>
        <div className="actions">
          {!status.running && <label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> I understand and explicitly request monitoring for this authorized work session.</label>}
          <button className="primary" disabled={busy || !canStart} onClick={() => void run('start_monitoring', { consentAcknowledged: consent })}>Start monitoring</button>
          <button className="danger" disabled={busy || !status.running} onClick={() => void run('stop_monitoring')}>Stop monitoring</button>
          {session.signedIn && <button className="quiet" disabled={busy} onClick={() => void run('employee_logout')}>Sign out & stop</button>}
        </div>
      </section>

      <section className="grid">
        <article className="card metric"><span>Agent</span><strong>{status.running ? 'Running' : 'Stopped'}</strong><small>{status.statusDetail}</small></article>
        <article className="card metric"><span>Backend</span><strong>{connection}</strong><small>{status.backendUrl || 'No endpoint stored'}</small></article>
        <article className="card metric"><span>Policy</span><strong>{policyLabel}</strong><small>Consent, authorization, schedule and revocation enforced by agent</small></article>
        <article className="card metric"><span>Offline queue</span><strong>{status.pendingQueue} pending</strong><small>{status.totalRecorded} locally recorded intervals</small></article>
      </section>

      <section className="details card">
        <div><span>Device</span><strong>{deviceShort}</strong></div><div><span>Enrollment</span><strong>{status.enrolled ? 'Protected credential available' : 'Required'}</strong></div>
        <div><span>Screenshot policy</span><strong>{status.running ? 'Checked by agent' : 'Inactive'}</strong></div><div><span>Work-session timer</span><strong>{status.running ? 'Agent controlled' : '00:00:00'}</strong></div>
      </section>

      {settingsOpen && <section className="settings card"><h2>Settings</h2><label className="toggle"><input type="checkbox" checked={launchOnLogin} onChange={async e => { const enabled=e.target.checked; setLaunchOnLogin(enabled); try { await invoke('set_launch_on_login', { enabled }); setMessage(enabled ? 'DigitalPulse will launch after Windows sign-in. Monitoring still requires valid authorization.' : 'Launch at sign-in disabled.'); } catch (error) { setLaunchOnLogin(!enabled); setMessage(errorMessage(error)); } }} /> Launch DigitalPulse when I sign in to Windows</label><button className="quiet" disabled={busy || !status.enrolled} onClick={() => void run('sync_now')}>Synchronize queued records now</button></section>}
    </main>
  </div>;
}

export default App;
