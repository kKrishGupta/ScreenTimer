import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { ErrorState, LoadingState } from '../components/ui/States.jsx';
import { HeartIcon } from '../components/ui/icons.jsx';

export default function DigitalWellbeingPage() {
  const fetchWellbeing = useCallback((opts) => api.wellbeingStatus(opts), []);
  const { data, error, loading, reload } = useApi(fetchWellbeing, { intervalMs: 5000 });

  const [breakActive, setBreakActive] = useState(false);
  const [breakTimer, setBreakTimer] = useState(20);
  const [busy, setBusy] = useState(false);

  const startEyeBreak = () => {
    setBreakActive(true);
    setBreakTimer(20);
    const interval = setInterval(() => {
      setBreakTimer((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setBreakActive(false);
          completeBreakApi();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const completeBreakApi = async () => {
    try {
      setBusy(true);
      await api.completeBreak();
      reload();
    } catch {
      // safe fallback
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading digital wellbeing metrics…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Digital Wellbeing & Health"
          description="Ergonomic habits, 20-20-20 eye strain reduction, and mindful technology breaks."
        />
        <Button
          onClick={startEyeBreak}
          disabled={busy || breakActive}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
        >
          {breakActive ? `Eye Rest in Progress (${breakTimer}s)` : 'Take a 20s Eye Break Now'}
        </Button>
      </div>

      {/* Full-Screen Eye Break Overlay if active */}
      {breakActive && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-md p-6 text-center text-white">
          <div className="grid h-24 w-24 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 mb-6 animate-pulse">
            <HeartIcon width={48} height={48} />
          </div>
          <h2 className="text-3xl font-bold">20-20-20 Eye Rest</h2>
          <p className="mt-2 text-slate-300 max-w-md">
            Look away from your screen at an object at least 20 feet (6 meters) away to relax your eye muscles.
          </p>
          <div className="my-8 text-6xl font-mono font-bold text-emerald-400">
            {breakTimer}s
          </div>
          <button
            onClick={() => setBreakActive(false)}
            className="text-xs text-slate-400 hover:text-white underline"
          >
            Skip Break
          </button>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 my-6">
        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Breaks Completed Today</p>
          <p className="mt-1 text-2xl font-bold text-emerald-400">{data?.breaksCompletedToday ?? 0}</p>
          <p className="text-xs text-slate-400 mt-1">Goal: 6 breaks / day</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Break Adherence</p>
          <p className="mt-1 text-2xl font-bold text-sky-400">88%</p>
          <p className="text-xs text-slate-400 mt-1">Excellent eye comfort</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Posture Check Status</p>
          <p className="mt-1 text-2xl font-bold text-purple-400">Active</p>
          <p className="text-xs text-slate-400 mt-1">Prompts every 45 mins</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Digital Wellbeing Score</p>
          <p className="mt-1 text-2xl font-bold text-amber-300">92 / 100</p>
          <p className="text-xs text-slate-400 mt-1">Balanced work rhythm</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 20-20-20 Rule Card */}
        <Card title="The 20-20-20 Eye Strain Rule">
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Prolonged close-up screen focus reduces blink rate by over 60%, causing computer vision syndrome
              and headaches. Every 20 minutes, DigitalPulse reminds you to look at least 20 feet away for 20 seconds.
            </p>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4 space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Current Eye Rest Interval:</span>
                <span className="font-mono text-emerald-400">Every 20 minutes</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Rest Duration:</span>
                <span className="font-mono text-slate-200">20 seconds</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Last Break:</span>
                <span className="font-mono text-slate-200">
                  {data?.lastBreakTakenAt ? new Date(data.lastBreakTakenAt).toLocaleTimeString() : 'Earlier today'}
                </span>
              </div>
            </div>
            <Button onClick={startEyeBreak} disabled={breakActive} className="w-full">
              Start 20s Eye Break Exercise
            </Button>
          </div>
        </Card>

        {/* Posture & Ergonomics Advice */}
        <Card title="Ergonomics & Posture Guidance">
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <span className="text-emerald-400 font-bold text-base">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">Screen Height Alignment</h4>
                <p className="text-xs text-slate-400 mt-0.5">The top third of your display should align with eye level to minimize cervical neck flexion.</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <span className="text-emerald-400 font-bold text-base">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">90-Degree Elbow & Knee Angles</h4>
                <p className="text-xs text-slate-400 mt-0.5">Keep forearms parallel to the desk and feet flat on the floor to prevent repetitive strain.</p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <span className="text-emerald-400 font-bold text-base">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">Hydration & Movement</h4>
                <p className="text-xs text-slate-400 mt-0.5">Stand up, stretch your back, and drink a glass of water every 60 minutes.</p>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
