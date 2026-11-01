import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { ScreenIcon } from '../components/ui/icons.jsx';

export default function ScreenMonitoringPage() {
  const fetchConfig = useCallback((opts) => api.screenConfig(opts), []);
  const fetchCaptures = useCallback((opts) => api.screenCaptures({ limit: 50 }, opts), []);

  const { data: config, error: configErr, loading: configLoading, reload: reloadConfig } = useApi(fetchConfig, { intervalMs: 3000 });
  const { data: capturesData, error: capturesErr, loading: capturesLoading, reload: reloadCaptures } = useApi(fetchCaptures, { intervalMs: 5000 });

  const [busy, setBusy] = useState(false);
  const [selectedCapture, setSelectedCapture] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);

  const captures = capturesData?.captures ?? [];

  const handleToggleConsent = async (grant) => {
    try {
      setBusy(true);
      await api.postScreenConsent(grant);
      setActionMessage(grant ? 'Screen monitoring consent enabled.' : 'Screen monitoring consent revoked.');
      reloadConfig();
      reloadCaptures();
    } catch (e) {
      alert(`Error updating consent: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStateChange = async (action, pauseMinutes = 15) => {
    try {
      setBusy(true);
      await api.postScreenState(action, pauseMinutes);
      setActionMessage(`Monitoring state updated to ${action}.`);
      reloadConfig();
    } catch (e) {
      alert(`Error updating monitoring state: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleManualCapture = async () => {
    try {
      setBusy(true);
      await api.postScreenCapture('Active Desktop Window');
      setActionMessage('Screenshot captured successfully.');
      reloadCaptures();
      reloadConfig();
    } catch (e) {
      alert(`Failed to capture screen: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCapture = async (id) => {
    if (!confirm('Are you sure you want to delete this screenshot?')) return;
    try {
      setBusy(true);
      await api.deleteScreenCapture(id);
      if (selectedCapture?.id === id) setSelectedCapture(null);
      setActionMessage('Screenshot deleted.');
      reloadCaptures();
      reloadConfig();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePurge = async () => {
    if (!confirm(`Purge all screenshots older than ${config?.retentionDays ?? 7} days?`)) return;
    try {
      setBusy(true);
      const res = await api.purgeScreenCaptures(config?.retentionDays ?? 7);
      setActionMessage(`Purged ${res.purgedCount} expired screenshots.`);
      reloadCaptures();
      reloadConfig();
    } catch (e) {
      alert(`Purge failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLiveSessionToggle = async () => {
    try {
      setBusy(true);
      if (config?.liveSession?.active) {
        await api.stopLiveSession();
        setActionMessage('Live screen-sharing session ended.');
      } else {
        await api.startLiveSession(15);
        setActionMessage('Live screen-sharing session started (15m valid).');
      }
      reloadConfig();
    } catch (e) {
      alert(`Live session error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (configLoading && !config) return <LoadingState label="Loading screen monitoring state…" />;
  if (configErr) return <ErrorState error={configErr} onRetry={reloadConfig} />;

  const isConsentGranted = !!config?.consentGranted;
  const status = config?.status ?? 'stopped';

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Screen Monitoring"
          description="Scheduled screenshot capture, consent flow, and temporary live screen-sharing."
        />
        {isConsentGranted && (
          <div className="flex items-center gap-2">
            <Button onClick={handleManualCapture} disabled={busy || status === 'paused'}>
              Capture Now
            </Button>
            <Button onClick={handleLiveSessionToggle} disabled={busy}>
              {config?.liveSession?.active ? 'Stop Live Share' : 'Start Live Share (15m)'}
            </Button>
          </div>
        )}
      </div>

      {actionMessage && (
        <div className="my-4 rounded-lg bg-sky-500/10 border border-sky-500/20 px-4 py-3 text-sm text-sky-300 flex justify-between items-center">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
        </div>
      )}

      {/* Consent & Permission Banner */}
      {!isConsentGranted ? (
        <Card>
          <div className="flex flex-col md:flex-row items-center gap-6 p-4">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-amber-500/10 text-amber-400 shrink-0">
              <ScreenIcon width={32} height={32} />
            </div>
            <div className="space-y-1 text-center md:text-left flex-1">
              <h2 className="text-lg font-semibold text-white">Explicit User Consent Required</h2>
              <p className="text-sm text-slate-300">
                Screen monitoring captures visual window snapshots on this computer. In compliance with DigitalPulse
                privacy policies, capture is completely disabled until affirmative local consent is granted by the user.
              </p>
            </div>
            <Button
              onClick={() => handleToggleConsent(true)}
              disabled={busy}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-5 py-2.5 shrink-0"
            >
              Grant Consent & Enable
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-6">
          {/* Status & Control Bar */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3.5 w-3.5">
                  {status === 'active' && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-3.5 w-3.5 ${
                      status === 'active'
                        ? 'bg-emerald-500'
                        : status === 'paused'
                        ? 'bg-amber-500'
                        : 'bg-slate-500'
                    }`}
                  ></span>
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100 uppercase tracking-wide text-xs">
                      Status: {status}
                    </span>
                    {status === 'paused' && config?.pauseUntil && (
                      <span className="text-xs text-amber-300">
                        (until {new Date(config.pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Interval: every {config?.captureIntervalMinutes ?? 10}m &bull; Retention: {config?.retentionDays ?? 7} days &bull; Total stored: {config?.totalCaptures ?? 0}
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                {status === 'active' ? (
                  <>
                    <Button onClick={() => handleStateChange('pause', 15)} disabled={busy}>
                      Pause 15m
                    </Button>
                    <Button onClick={() => handleStateChange('pause', 60)} disabled={busy}>
                      Pause 1h
                    </Button>
                    <Button onClick={() => handleStateChange('stop')} disabled={busy}>
                      Stop
                    </Button>
                  </>
                ) : status === 'paused' ? (
                  <Button onClick={() => handleStateChange('resume')} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-white">
                    Resume
                  </Button>
                ) : (
                  <Button onClick={() => handleStateChange('resume')} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-white">
                    Start Monitoring
                  </Button>
                )}

                <Button onClick={handlePurge} disabled={busy} title="Purge captures older than retention period">
                  Purge Expired
                </Button>
                <Button onClick={() => handleToggleConsent(false)} disabled={busy} className="text-rose-400 border-rose-500/20 hover:border-rose-500/40">
                  Revoke Consent
                </Button>
              </div>
            </div>

            {/* Live session banner if active */}
            {config?.liveSession?.active && (
              <div className="mt-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-300 flex items-center justify-between">
                <div>
                  <span className="font-semibold">Live Screen Share Active: </span>
                  <span>Expires at {new Date(config.liveSession.expiresAt).toLocaleTimeString()}</span>
                </div>
                <Button onClick={handleLiveSessionToggle} disabled={busy}>End Session</Button>
              </div>
            )}
          </Card>

          {/* Screenshot Gallery */}
          <Card title={`Captured Screenshots (${captures.length})`}>
            {capturesLoading && !capturesData && <LoadingState label="Loading captures…" />}
            {capturesErr && <ErrorState error={capturesErr} onRetry={reloadCaptures} />}

            {!capturesLoading && captures.length === 0 && (
              <EmptyState title="No screenshots captured yet">
                Screen monitoring is active. Captures will appear here automatically based on your schedule,
                or click "Capture Now" to take a screenshot right away.
              </EmptyState>
            )}

            {captures.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {captures.map((cap) => (
                  <div
                    key={cap.id}
                    className="group relative rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden hover:border-accent-400/30 transition flex flex-col"
                  >
                    <div
                      className="cursor-pointer aspect-video bg-slate-900 overflow-hidden relative"
                      onClick={() => setSelectedCapture(cap)}
                    >
                      <img
                        src={cap.previewUrl}
                        alt={cap.applicationName}
                        className="w-full h-full object-cover group-hover:scale-102 transition duration-200"
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs font-medium">
                        Click to preview
                      </div>
                    </div>

                    <div className="p-3 flex-1 flex flex-col justify-between">
                      <div>
                        <p className="text-xs font-semibold text-slate-100 truncate" title={cap.applicationName}>
                          {cap.applicationName}
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {new Date(cap.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2 text-[11px]">
                        <span className="text-slate-400">{Math.round(cap.sizeBytes / 1024)} KB &bull; {cap.width}x{cap.height}</span>
                        <button
                          onClick={() => handleDeleteCapture(cap.id)}
                          disabled={busy}
                          className="text-rose-400 hover:text-rose-300 transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Modal for viewing capture preview */}
      {selectedCapture && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setSelectedCapture(null)}
        >
          <div
            className="max-w-4xl w-full rounded-xl bg-surface-900 border border-white/10 overflow-hidden shadow-2xl space-y-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-white">{selectedCapture.applicationName}</h3>
                <p className="text-xs text-slate-400 font-mono">
                  {new Date(selectedCapture.timestamp).toLocaleString()} &bull; {selectedCapture.width}x{selectedCapture.height}
                </p>
              </div>
              <button
                onClick={() => setSelectedCapture(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="rounded-lg overflow-hidden border border-white/5 bg-slate-950 flex items-center justify-center aspect-video max-h-[60vh]">
              <img
                src={selectedCapture.previewUrl}
                alt={selectedCapture.applicationName}
                className="w-full h-full object-contain"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button onClick={() => handleDeleteCapture(selectedCapture.id)} className="text-rose-400 border-rose-500/20">
                Delete Screenshot
              </Button>
              <Button onClick={() => setSelectedCapture(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
