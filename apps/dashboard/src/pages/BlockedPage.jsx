import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router';
import { api } from '../lib/api.js';
import { ShieldIcon, GlobeIcon, DeviceIcon, PulseIcon } from '../components/ui/icons.jsx';
import { Button } from '../components/ui/Card.jsx';

export default function BlockedPage() {
  const [searchParams] = useSearchParams();
  const domain = searchParams.get('domain') || 'restricted-domain.com';
  const policyName = searchParams.get('policy') || 'Enterprise Acceptable Use Policy';

  const [graceState, setGraceState] = useState(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionUrgency, setExceptionUrgency] = useState('normal');
  const [exceptionSubmitted, setExceptionSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Load grace grants status for this domain
  useEffect(() => {
    let timer = null;

    const checkGrace = async () => {
      try {
        const res = await api.graceGrants();
        const grant = (res.grants || []).find((g) => g.domain?.toLowerCase() === domain.toLowerCase());
        if (grant) {
          setGraceState(grant.status);
          setRemainingSeconds(grant.remainingSeconds || 0);
        } else {
          setGraceState('NOT_VISITED');
          setRemainingSeconds(900); // 15 mins available
        }
      } catch {
        // Fallback default
        setGraceState('NOT_VISITED');
        setRemainingSeconds(900);
      }
    };

    checkGrace();

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [domain]);

  // Countdown timer when grace is active
  useEffect(() => {
    if (graceState !== 'GRACE_ACTIVE' || remainingSeconds <= 0) return;

    const interval = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          setGraceState('BLOCKED');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [graceState, remainingSeconds]);

  const handleStartGrace = async () => {
    try {
      setBusy(true);
      setErrorMsg(null);
      const res = await api.graceVisit(domain);
      setGraceState(res.status || 'GRACE_ACTIVE');
      setRemainingSeconds(res.remainingSeconds || 900);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to activate grace period.');
    } finally {
      setBusy(false);
    }
  };

  const handleRequestException = async (e) => {
    e.preventDefault();
    if (!exceptionReason.trim()) return;
    try {
      setBusy(true);
      // Log exception request as an alert/audit in backend
      await api.checkPolicy({
        domain,
        url: `https://${domain}`,
        employeeName: 'Current User',
        reason: `Exemption requested (${exceptionUrgency}): ${exceptionReason.trim()}`,
      });
      setExceptionSubmitted(true);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to submit exception request.');
    } finally {
      setBusy(false);
    }
  };

  const formatCountdown = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 flex flex-col justify-between p-4 sm:p-8 font-sans selection:bg-rose-500 selection:text-white">
      {/* Top Navigation Brand */}
      <header className="max-w-4xl w-full mx-auto flex items-center justify-between border-b border-white/5 pb-4">
        <Link to="/" className="flex items-center gap-2 group">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-500/15 text-sky-400 group-hover:scale-105 transition">
            <PulseIcon />
          </span>
          <div>
            <span className="text-base font-bold text-white tracking-tight">DigitalPulse</span>
            <span className="text-[10px] uppercase font-bold text-sky-400 ml-1.5 tracking-wider">Enterprise Security</span>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping"></span>
            Enforcement Active
          </span>
        </div>
      </header>

      {/* Main Blocked Container */}
      <main className="max-w-2xl w-full mx-auto my-8">
        <div className="rounded-2xl border border-rose-500/30 bg-slate-900/90 shadow-2xl shadow-rose-950/40 p-6 sm:p-10 backdrop-blur text-center relative overflow-hidden">
          {/* Subtle Ambient Red Glow */}
          <div className="absolute -top-24 -left-24 w-48 h-48 bg-rose-500/15 rounded-full blur-3xl pointer-events-none"></div>
          <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-sky-500/10 rounded-full blur-3xl pointer-events-none"></div>

          {/* Hero Icon */}
          <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-2xl bg-gradient-to-br from-rose-500/20 to-rose-950/40 border border-rose-500/30 text-rose-400 shadow-lg shadow-rose-500/10">
            <ShieldIcon width={40} height={40} />
          </div>

          {/* Title & Domain */}
          <span className="px-3 py-1 rounded-full text-xs font-mono font-bold tracking-widest uppercase bg-rose-500/15 text-rose-300 border border-rose-500/20">
            Access Restricted &bull; Policy Violation
          </span>

          <h1 className="mt-4 text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Navigation to <span className="font-mono text-rose-300 underline decoration-rose-500/50">{domain}</span> is Blocked
          </h1>

          <p className="mt-3 text-sm text-slate-300 leading-relaxed max-w-lg mx-auto">
            In accordance with your organization's digital wellbeing and acceptable use governance, access to this category is restricted on managed endpoints during active work hours.
          </p>

          {/* Structured Policy Metadata Table */}
          <div className="mt-6 rounded-xl border border-white/10 bg-surface-950/80 p-4 text-xs font-mono text-left space-y-2.5">
            <div className="flex justify-between items-center pb-2 border-b border-white/5">
              <span className="text-slate-400 flex items-center gap-1.5">
                <ShieldIcon width={14} height={14} className="text-rose-400" />
                Active Policy:
              </span>
              <span className="font-semibold text-rose-200">{policyName}</span>
            </div>

            <div className="flex justify-between items-center pb-2 border-b border-white/5">
              <span className="text-slate-400 flex items-center gap-1.5">
                <GlobeIcon width={14} height={14} className="text-sky-400" />
                Target Filter:
              </span>
              <span className="font-semibold text-sky-300">||{domain}</span>
            </div>

            <div className="flex justify-between items-center pb-2 border-b border-white/5">
              <span className="text-slate-400 flex items-center gap-1.5">
                <DeviceIcon width={14} height={14} className="text-slate-400" />
                Enforcement Engine:
              </span>
              <span className="text-slate-300">Chrome / Edge Manifest V3 DNR</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-slate-400">Grace Status:</span>
              <span className={`font-bold uppercase ${
                graceState === 'GRACE_ACTIVE'
                  ? 'text-emerald-400'
                  : graceState === 'BLOCKED'
                  ? 'text-rose-400'
                  : 'text-amber-400'
              }`}>
                {graceState === 'GRACE_ACTIVE'
                  ? `Grace Active (${formatCountdown(remainingSeconds)} left)`
                  : graceState === 'BLOCKED'
                  ? 'Allowance Expired'
                  : '15m Available Today'}
              </span>
            </div>
          </div>

          {errorMsg && (
            <div className="mt-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-left">
              {errorMsg}
            </div>
          )}

          {/* 15-Minute Grace Period Active or Available Banner */}
          {graceState === 'GRACE_ACTIVE' ? (
            <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 text-center space-y-2">
              <div className="flex items-center justify-center gap-2 text-emerald-300 font-bold text-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
                <span>15-Minute Temporary Grace Period Running</span>
              </div>
              <p className="text-xs text-slate-300">
                You have <span className="font-mono font-bold text-emerald-300 text-sm">{formatCountdown(remainingSeconds)}</span> of personal allowance remaining before restriction re-engages.
              </p>
              <div className="pt-2">
                <a
                  href={`https://${domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-lg transition"
                >
                  Proceed to {domain} &rarr;
                </a>
              </div>
            </div>
          ) : graceState === 'NOT_VISITED' ? (
            <div className="mt-6 rounded-xl border border-purple-500/30 bg-purple-950/20 p-4 text-center space-y-3">
              <div>
                <h4 className="text-sm font-bold text-purple-200">Need Quick Access?</h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  Your policy includes a one-time 15-minute daily grace period for personal or unexpected lookups.
                </p>
              </div>
              <Button
                onClick={handleStartGrace}
                disabled={busy}
                className="bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs px-4 py-2 shadow-lg"
              >
                {busy ? 'Activating...' : 'Activate 15-Minute Grace Period'}
              </Button>
            </div>
          ) : (
            <div className="mt-4 text-xs text-slate-400">
              Daily 15-minute grace period has expired. Continuous access requires administrator authorization.
            </div>
          )}

          {/* Action Buttons */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 pt-4 border-t border-white/5">
            <Link
              to="/"
              className="px-4 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-slate-200 text-xs font-semibold border border-white/10 transition"
            >
              &larr; Return to Dashboard
            </Link>

            <Link
              to="/policies"
              className="px-4 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-slate-200 text-xs font-semibold border border-white/10 transition"
            >
              View Organization Policies
            </Link>

            <button
              onClick={() => setShowExceptionModal(true)}
              className="px-4 py-2 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 text-xs font-semibold border border-sky-500/30 transition"
            >
              Request Business Exemption
            </button>
          </div>
        </div>
      </main>

      {/* Exemption Request Modal */}
      {showExceptionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="rounded-2xl border border-sky-500/30 bg-slate-900 p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldIcon width={16} height={16} className="text-sky-400" />
                Request Policy Exemption
              </h3>
              <button onClick={() => setShowExceptionModal(false)} className="text-slate-400 hover:text-white text-sm">
                ✕
              </button>
            </div>

            {exceptionSubmitted ? (
              <div className="text-center py-6 space-y-3">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 grid place-items-center mx-auto text-xl">
                  ✓
                </div>
                <h4 className="text-sm font-bold text-white">Exemption Ticket Dispatched</h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Your business justification for <strong className="text-slate-200">{domain}</strong> has been logged and sent to your administrator for review.
                </p>
                <Button onClick={() => setShowExceptionModal(false)} className="text-xs mt-2">
                  Done
                </Button>
              </div>
            ) : (
              <form onSubmit={handleRequestException} className="space-y-4 text-xs">
                <div>
                  <label className="text-slate-400 block mb-1">Target Restricted Domain</label>
                  <input
                    type="text"
                    readOnly
                    value={domain}
                    className="w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-1.5 text-xs text-sky-300 font-mono"
                  />
                </div>

                <div>
                  <label className="text-slate-300 font-semibold block mb-1">Business Justification *</label>
                  <textarea
                    rows={3}
                    required
                    placeholder="Describe why this website is required for your official duties (e.g. client project, competitor research)..."
                    value={exceptionReason}
                    onChange={(e) => setExceptionReason(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-slate-300 font-semibold block mb-1">Urgency Level</label>
                  <select
                    value={exceptionUrgency}
                    onChange={(e) => setExceptionUrgency(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-1.5 text-xs text-slate-200"
                  >
                    <option value="normal">Standard Business Request (Within 24 hours)</option>
                    <option value="urgent">Urgent / Blocking Active Work (Immediate)</option>
                    <option value="temporary">Temporary 1-Hour Access Grant</option>
                  </select>
                </div>

                <div className="pt-3 flex justify-end gap-2 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setShowExceptionModal(false)}
                    className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white"
                  >
                    Cancel
                  </button>
                  <Button type="submit" disabled={busy || !exceptionReason.trim()} className="bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs">
                    {busy ? 'Submitting...' : 'Submit Request'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Governance & Privacy Disclosed Notice Footer */}
      <footer className="max-w-4xl w-full mx-auto text-center border-t border-white/5 pt-4 text-[11px] text-slate-400 space-y-1">
        <p>
          DigitalPulse Enterprise Endpoint Activity Intelligence &bull; Authorized Workplace Governance &bull; Non-covert Disclosed Monitoring
        </p>
        <p className="text-slate-400 font-mono text-[10px]">
          Redirected by Chrome/Edge DeclarativeNetRequest Policy Engine &bull; Timestamp: {new Date().toLocaleString()}
        </p>
      </footer>
    </div>
  );
}

