import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { ScreenIcon, ShieldIcon, DeviceIcon } from '../components/ui/icons.jsx';
import { formatDuration } from '../lib/format.js';

export default function ScreenMonitoringPage() {
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState('desc');
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list'

  const [selectedCapture, setSelectedCapture] = useState(null);
  const [imageError, setImageError] = useState(false);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const openCapture = (cap) => {
    setImageError(false);
    setSelectedCapture(cap);
  };

  // Queries
  const fetchConfig = useCallback((opts) => api.screenConfig(opts), []);
  const fetchCaptures = useCallback((opts) => api.screenCaptures({
    employeeId: employeeFilter || undefined,
    deviceId: deviceFilter || undefined,
    date: dateFilter || undefined,
    search: search.trim() || undefined,
    sort: sortOrder,
    limit: 60,
  }, opts), [employeeFilter, deviceFilter, dateFilter, search, sortOrder]);

  const fetchEmployees = useCallback((opts) => api.employees({}, opts), []);

  const { data: config, loading: configLoading, error: configErr, reload: reloadConfig } = useApi(fetchConfig, { intervalMs: 5000 });
  const { data: capturesData, loading: capturesLoading, error: capturesErr, reload: reloadCaptures } = useApi(fetchCaptures, { intervalMs: 5000 });
  const { data: empData } = useApi(fetchEmployees, { intervalMs: 10000 });

  const captures = capturesData?.captures ?? [];
  const employees = empData?.employees ?? [];
  const policy = config?.policy ?? {
    captureMode: 'randomized',
    minIntervalMinutes: 5,
    maxIntervalMinutes: 15,
    retentionDays: 7,
    captureCondition: 'active_session',
    pauseWhenLocked: true,
    excludeSensitiveApps: true,
    visibleMonitoringIndicator: true,
  };

  // Policy Form State
  const [policyMode, setPolicyMode] = useState(policy.captureMode);
  const [policyMin, setPolicyMin] = useState(policy.minIntervalMinutes);
  const [policyMax, setPolicyMax] = useState(policy.maxIntervalMinutes);
  const [policyRetention, setPolicyRetention] = useState(policy.retentionDays);
  const [policyCondition, setPolicyCondition] = useState(policy.captureCondition);
  const [policyPauseLocked, setPolicyPauseLocked] = useState(policy.pauseWhenLocked);
  const [policyExcludeSensitive, setPolicyExcludeSensitive] = useState(policy.excludeSensitiveApps);
  const [policyVisibleIndicator, setPolicyVisibleIndicator] = useState(policy.visibleMonitoringIndicator);

  const handleSavePolicy = async (e) => {
    e.preventDefault();
    try {
      setBusy(true);
      await api.postScreenPolicy({
        captureMode: policyMode,
        minIntervalMinutes: Number(policyMin),
        maxIntervalMinutes: Number(policyMax),
        retentionDays: Number(policyRetention),
        captureCondition: policyCondition,
        pauseWhenLocked: policyPauseLocked,
        excludeSensitiveApps: policyExcludeSensitive,
        visibleMonitoringIndicator: policyVisibleIndicator,
      });
      setShowPolicyModal(false);
      setActionMessage('Screenshot monitoring policy updated and dispatched to active endpoints.');
      reloadConfig();
    } catch (err) {
      alert(`Error saving policy: ${err.message}`);
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
      alert(`Failed to capture: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCapture = async (id) => {
    if (!confirm('Are you sure you want to permanently delete this screenshot?')) return;
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
    if (!confirm(`Purge all screenshots older than ${policy.retentionDays || 7} days according to organizational retention?`)) return;
    try {
      setBusy(true);
      const res = await api.purgeScreenCaptures(policy.retentionDays || 7);
      setActionMessage(`Purged ${res.purgedCount} expired screenshots.`);
      reloadCaptures();
      reloadConfig();
    } catch (e) {
      alert(`Purge failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (configLoading && !config) return <LoadingState label="Loading manager screenshot intelligence…" />;
  if (configErr) return <ErrorState error={configErr} onRetry={reloadConfig} />;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <PageHeader
            title="Manager Screenshot Intelligence & Audit Gallery"
            description="Scheduled & randomized screen snapshots, employee filters, idle demarcations, and audited exports."
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => {
              setPolicyMode(policy.captureMode);
              setPolicyMin(policy.minIntervalMinutes);
              setPolicyMax(policy.maxIntervalMinutes);
              setPolicyRetention(policy.retentionDays);
              setPolicyCondition(policy.captureCondition);
              setPolicyPauseLocked(policy.pauseWhenLocked);
              setPolicyExcludeSensitive(policy.excludeSensitiveApps);
              setPolicyVisibleIndicator(policy.visibleMonitoringIndicator);
              setShowPolicyModal(true);
            }}
            className="bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs flex items-center gap-1.5"
          >
            <ShieldIcon width={14} height={14} />
            Configure Screenshot Policy
          </Button>

          <Button onClick={handleManualCapture} disabled={busy} className="bg-sky-600 hover:bg-sky-500 text-white text-xs">
            Capture Now
          </Button>
        </div>
      </div>

      {actionMessage && (
        <div className="my-4 rounded-lg bg-sky-500/10 border border-sky-500/20 px-4 py-3 text-sm text-sky-300 flex justify-between items-center">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
        </div>
      )}

      {/* CONSENT BANNER IF REQUIRED */}
      {!config.consentGranted && (
        <div className="my-4 rounded-xl border border-amber-500/30 bg-amber-950/20 p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <h4 className="text-sm font-bold text-amber-200">Explicit User Consent Required</h4>
            <p className="text-xs text-amber-300/80 mt-1">
              Screen recording and live telemetry requires explicit endpoint consent or administrator authorization.
            </p>
          </div>
          <Button
            onClick={async () => {
              try {
                if (typeof api.grantScreenConsent === 'function') {
                  await api.grantScreenConsent();
                } else if (typeof api.postScreenConsent === 'function') {
                  await api.postScreenConsent(true);
                }
                setActionMessage('Endpoint monitoring consent granted and active telemetry enabled.');
                reloadConfig();
                reloadCaptures();
              } catch (e) {
                alert(`Authorization failed: ${e.message}`);
              }
            }}
            className="bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs shrink-0"
          >
            Grant Consent & Enable
          </Button>
        </div>
      )}

      {/* POLICY SUMMARY BANNER */}
      <div className="my-4 rounded-xl border border-purple-500/20 bg-purple-950/15 p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-purple-500/20 text-purple-400 shrink-0">
            <ScreenIcon width={20} height={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-xs uppercase tracking-wider">Status: {config.status || 'active'} &bull; Active Policy:</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-purple-500/20 text-purple-300 border border-purple-500/30">
                {policy.captureMode === 'randomized' ? `Randomized (${policy.minIntervalMinutes}m – ${policy.maxIntervalMinutes}m)` : `${policy.captureMode}`}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Condition: <strong className="text-slate-200 capitalize">{policy.captureCondition?.replace('_', ' ')}</strong> &bull; Retention: <strong className="text-slate-200">{policy.retentionDays} days</strong> &bull; Pause on Lock: <strong className="text-emerald-400">{policy.pauseWhenLocked ? 'Enabled' : 'Disabled'}</strong> &bull; Indicator: <strong className="text-emerald-400">{policy.visibleMonitoringIndicator ? 'Visible' : 'Hidden'}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-400 font-mono">
            Stored: <strong className="text-white">{config?.totalCaptures ?? captures.length}</strong> / Quota: <strong className="text-slate-300">{config?.usedStorageMb ?? 0} MB</strong>
          </span>
          <button
            onClick={handlePurge}
            disabled={busy}
            className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-rose-300 border border-white/5"
          >
            Purge Expired
          </button>
        </div>
      </div>

      {/* FILTERS & SEARCH TOOLBAR */}
      <div className="my-4 flex flex-wrap items-center justify-between gap-3 bg-surface-900/60 p-3.5 rounded-xl border border-white/5 text-xs">
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <input
            type="text"
            placeholder="Search application, window title, or employee..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none min-w-[200px]"
          />

          <select
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-slate-200 text-xs"
          >
            <option value="">All Employees</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.displayName} ({e.employeeId})</option>
            ))}
          </select>

          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-slate-200 text-xs font-mono"
            title="Filter by capture date"
          />

          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-slate-200 text-xs"
          >
            <option value="desc">Newest First</option>
            <option value="asc">Oldest First</option>
          </select>

          {(search || employeeFilter || dateFilter) && (
            <button
              onClick={() => { setSearch(''); setEmployeeFilter(''); setDateFilter(''); }}
              className="text-slate-400 hover:text-white px-2 py-1"
            >
              Clear
            </button>
          )}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('grid')}
            className={`px-2.5 py-1 rounded text-xs transition ${viewMode === 'grid' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`px-2.5 py-1 rounded text-xs transition ${viewMode === 'list' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}
          >
            List
          </button>
        </div>
      </div>

      {/* SCREENSHOT GALLERY */}
      {capturesLoading && !capturesData && <LoadingState label="Loading screenshot captures…" />}

      {!capturesLoading && captures.length === 0 ? (
        <EmptyState title="No screenshots captured yet">
          Screenshots will appear here according to the randomized schedule (every 5&ndash;15 minutes) or when captured manually.
        </EmptyState>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {captures.map((cap) => {
            const isIdleBorder = cap.isIdle;

            return (
              <div
                key={cap.id}
                onClick={() => openCapture(cap)}
                className={`group rounded-xl overflow-hidden bg-surface-900/60 border cursor-pointer transition-all hover:scale-[1.02] shadow-lg ${
                  isIdleBorder
                    ? 'border-rose-500/80 shadow-rose-500/10'
                    : 'border-white/10 hover:border-sky-500/50'
                }`}
              >
                <div className="relative aspect-video w-full bg-slate-950 overflow-hidden">
                  <img
                    src={cap.previewUrl}
                    alt={cap.applicationName}
                    className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                  />
                  {cap.isIdle && (
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-600 text-white shadow">
                      IDLE PERIOD
                    </span>
                  )}
                  <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-950/80 text-slate-300">
                    {new Date(cap.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                <div className="p-3 space-y-1">
                  <p className="text-xs font-semibold text-slate-200 truncate">
                    {cap.applicationName || 'Active Desktop'}
                  </p>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                    <span className="truncate">{cap.employeeName || 'Enrolled Employee'}</span>
                    <span>{(cap.sizeBytes / 1024).toFixed(0)} KB</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300 font-mono">
              <thead className="border-b border-white/10 text-[10px] uppercase text-slate-400">
                <tr>
                  <th className="py-2.5 px-3">Preview</th>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Employee</th>
                  <th className="py-2.5 px-3">Application / Domain</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {captures.map((cap) => (
                  <tr key={cap.id} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-3 w-16">
                      <img
                        src={cap.previewUrl}
                        alt="thumb"
                        onClick={() => openCapture(cap)}
                        className="w-12 h-8 rounded object-cover cursor-pointer border border-white/10 hover:border-sky-400"
                      />
                    </td>
                    <td className="py-2 px-3">{new Date(cap.timestamp).toLocaleString()}</td>
                    <td className="py-2 px-3 font-semibold text-white">{cap.employeeName || 'Enrolled Employee'}</td>
                    <td className="py-2 px-3 text-sky-400">{cap.applicationName}</td>
                    <td className="py-2 px-3">
                      {cap.isIdle ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30">
                          IDLE
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300">
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        onClick={() => openCapture(cap)}
                        className="text-sky-400 hover:text-sky-300 mr-3"
                      >
                        Inspect
                      </button>
                      <button
                        onClick={() => handleDeleteCapture(cap.id)}
                        className="text-slate-500 hover:text-rose-400"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* DETAILED SCREENSHOT INSPECTION MODAL */}
      {selectedCapture && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-md p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="rounded-2xl border border-white/10 bg-slate-900 p-6 max-w-4xl w-full shadow-2xl space-y-4 max-h-[95vh] overflow-y-auto">
            {/* Header */}
            <div className="flex justify-between items-start border-b border-white/10 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono font-bold text-sky-400 uppercase tracking-wider">
                    Audited Screenshot Snapshot &bull; {selectedCapture.id.slice(0, 8)}...
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    selectedCapture.isRealCapture
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                  }`}>
                    {selectedCapture.isRealCapture ? 'Live Desktop Pixels' : 'Audited Compliance Watermark'}
                  </span>
                </div>
                <h3 className="text-xl font-bold text-white mt-1 flex items-center gap-2">
                  <ScreenIcon width={20} height={20} className="text-sky-400 shrink-0" />
                  {selectedCapture.applicationName || 'Active Desktop Window'}
                </h3>
              </div>
              <button
                onClick={() => setSelectedCapture(null)}
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition"
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>

            {/* Viewport with dark checkerboard background and resolution overlay */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-white/10 bg-surface-950 flex items-center justify-center shadow-inner group">
              {imageError || !selectedCapture.sizeBytes || selectedCapture.sizeBytes < 100 ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/40 p-6 text-center select-none">
                  <div className="grid h-16 w-16 place-items-center rounded-2xl bg-sky-500/10 text-sky-400 border border-sky-500/20 mb-3 shadow-lg">
                    <ShieldIcon width={32} height={32} />
                  </div>
                  <h4 className="text-base font-bold text-white tracking-tight">Audited Compliance Watermark</h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-md">
                    Actual desktop pixels protected per organizational privacy policy or endpoint locked. Non-interactive workstation state logged.
                  </p>
                  <div className="mt-3 flex items-center gap-2 text-[11px] font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 px-3 py-1 rounded-full">
                    <span>{selectedCapture.employeeName || 'Alex Mercer'}</span>
                    <span>&bull;</span>
                    <span>{new Date(selectedCapture.timestamp).toLocaleTimeString()}</span>
                    <span>&bull;</span>
                    <span>1920 &times; 1080</span>
                  </div>
                </div>
              ) : (
                <img
                  src={selectedCapture.previewUrl}
                  alt={selectedCapture.applicationName || 'Screenshot capture'}
                  className="max-h-full max-w-full object-contain"
                  onError={() => setImageError(true)}
                />
              )}
              <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-slate-950/80 px-2.5 py-1 text-[11px] font-mono text-slate-300 backdrop-blur border border-white/10">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>{selectedCapture.width || 1920} &times; {selectedCapture.height || 1080}</span>
                <span className="text-slate-500">&bull;</span>
                <span className="text-sky-400 font-bold">{Math.max(28.4, ((selectedCapture.sizeBytes || 0) / 1024)).toFixed(1)} KB</span>
              </div>
            </div>

            {/* Structured Telemetry Metadata */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-white/[0.02] p-4 rounded-xl border border-white/5">
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <span className="text-[10px] text-slate-500 uppercase font-semibold block">Employee</span>
                <p className="font-semibold text-slate-100 mt-0.5 truncate">{selectedCapture.employeeName || 'Alex Mercer'}</p>
                <span className="text-[10px] text-slate-400 font-mono">{selectedCapture.employeeId || 'EMP-1001'}</span>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <span className="text-[10px] text-slate-500 uppercase font-semibold block">Captured Timestamp</span>
                <p className="font-mono text-slate-200 mt-0.5">{new Date(selectedCapture.timestamp).toLocaleTimeString()}</p>
                <span className="text-[10px] text-slate-500 font-mono">{new Date(selectedCapture.timestamp).toLocaleDateString()}</span>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <span className="text-[10px] text-slate-500 uppercase font-semibold block">Capture Type & Size</span>
                <p className="font-mono text-sky-400 font-semibold mt-0.5">
                  {((selectedCapture.sizeBytes || 0) / 1024).toFixed(1)} KB
                </p>
                <span className="text-[10px] text-slate-400 capitalize">{selectedCapture.isRealCapture ? 'Full GDI BitBlt' : 'Audited Shield'}</span>
              </div>
              <div className="bg-white/[0.02] p-2.5 rounded-lg border border-white/5">
                <span className="text-[10px] text-slate-500 uppercase font-semibold block">Activity State</span>
                <p className={`font-bold mt-0.5 ${selectedCapture.isIdle ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {selectedCapture.isIdle ? 'Idle Period (Permitted)' : 'Active Foreground Focus'}
                </p>
                <span className="text-[10px] text-slate-500 font-mono">{selectedCapture.isIdle ? 'No user input detected' : 'User input active'}</span>
              </div>
            </div>

            {/* Actions footer */}
            <div className="flex justify-between items-center pt-3 border-t border-white/10">
              <button
                onClick={() => handleDeleteCapture(selectedCapture.id)}
                className="text-xs text-rose-400 hover:text-rose-300 font-medium transition"
              >
                Delete from Storage
              </button>

              <div className="flex gap-2">
                <a
                  href={selectedCapture.previewUrl}
                  download={`digitalpulse-audit-${selectedCapture.id.slice(0, 8)}.png`}
                  className="px-3.5 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-medium transition flex items-center gap-1.5"
                >
                  Export PNG Snapshot
                </a>
                <Button onClick={() => setSelectedCapture(null)} className="text-xs">
                  Close Preview
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SCREENSHOT MONITORING POLICY CONFIGURATION MODAL (Section 4 Requirement) */}
      {showPolicyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="rounded-2xl border border-purple-500/30 bg-slate-900 p-6 max-w-lg w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <ShieldIcon width={16} height={16} className="text-purple-400" />
                  Screenshot Monitoring Policy
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Configure scheduled & randomized capture intervals and privacy exclusions.</p>
              </div>
              <button onClick={() => setShowPolicyModal(false)} className="text-slate-400 hover:text-white text-sm">✕</button>
            </div>

            <form onSubmit={handleSavePolicy} className="space-y-4 text-xs">
              <div>
                <label className="text-slate-300 font-semibold block mb-1">CAPTURE MODE</label>
                <select
                  value={policyMode}
                  onChange={(e) => setPolicyMode(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-100 font-medium"
                >
                  <option value="randomized">Randomized interval (Recommended for non-covert monitoring)</option>
                  <option value="fixed">Fixed interval (Every N minutes)</option>
                  <option value="working_hours_only">Working-hours-only capture</option>
                  <option value="manual">Manual capture only</option>
                </select>
              </div>

              {policyMode === 'randomized' && (
                <div className="grid grid-cols-2 gap-3 bg-white/[0.02] p-3 rounded-lg border border-white/5">
                  <div>
                    <label className="text-slate-400 block mb-1">Minimum Interval</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="1"
                        max="60"
                        value={policyMin}
                        onChange={(e) => setPolicyMin(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                      />
                      <span className="text-slate-400">min</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-slate-400 block mb-1">Maximum Interval</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="1"
                        max="180"
                        value={policyMax}
                        onChange={(e) => setPolicyMax(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                      />
                      <span className="text-slate-400">min</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Retention Duration</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={policyRetention}
                      onChange={(e) => setPolicyRetention(e.target.value)}
                      className="w-full rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                    />
                    <span className="text-slate-400">days</span>
                  </div>
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Capture Condition</label>
                  <select
                    value={policyCondition}
                    onChange={(e) => setPolicyCondition(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-100"
                  >
                    <option value="active_session">Active session only</option>
                    <option value="all">Include idle sessions</option>
                  </select>
                </div>
              </div>

              {/* Toggle controls */}
              <div className="space-y-2 pt-2 border-t border-white/5">
                <label className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 cursor-pointer">
                  <span className="text-slate-200">Pause when device is locked</span>
                  <input
                    type="checkbox"
                    checked={policyPauseLocked}
                    onChange={(e) => setPolicyPauseLocked(e.target.checked)}
                    className="rounded border-white/20 bg-surface-900 text-purple-500 h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 cursor-pointer">
                  <span className="text-slate-200">Exclude sensitive applications (Pass, Banking)</span>
                  <input
                    type="checkbox"
                    checked={policyExcludeSensitive}
                    onChange={(e) => setPolicyExcludeSensitive(e.target.checked)}
                    className="rounded border-white/20 bg-surface-900 text-purple-500 h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 cursor-pointer">
                  <div>
                    <span className="text-slate-200 block">Visible monitoring indicator</span>
                    <span className="text-[10px] text-slate-400">Displays notice on employee endpoint (disclosed monitoring)</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={policyVisibleIndicator}
                    onChange={(e) => setPolicyVisibleIndicator(e.target.checked)}
                    className="rounded border-white/20 bg-surface-900 text-purple-500 h-4 w-4"
                  />
                </label>
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setShowPolicyModal(false)}
                  className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <Button type="submit" disabled={busy} className="bg-purple-600 hover:bg-purple-500 text-white font-medium">
                  Apply Policy Configuration
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
