import { useCallback, useState, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { HeartIcon } from '../components/ui/icons.jsx';
import { formatDuration } from '../lib/format.js';

const COLOR_PALETTE = [
  '#38bdf8', // Cyan
  '#2dd4bf', // Teal
  '#818cf8', // Indigo
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#f43f5e', // Rose
  '#64748b', // Slate
];

const CATEGORY_COLORS = {
  Productivity: '#38bdf8',
  Education: '#10b981',
  Communication: '#818cf8',
  'Social Media': '#f43f5e',
  Entertainment: '#f59e0b',
  Finance: '#2dd4bf',
  Shopping: '#ec4899',
  Other: '#64748b',
};

/**
 * Interactive SVG Donut Chart
 */
function DonutChart({ items, totalSeconds, label, onSelect, selectedItem }) {
  const [hoveredItem, setHoveredItem] = useState(null);
  const activeItem = hoveredItem || selectedItem || items[0] || null;

  const radius = 75;
  const strokeWidth = 24;
  const circumference = 2 * Math.PI * radius;

  // Compute slice offsets
  const slices = useMemo(() => {
    if (!items || items.length === 0 || totalSeconds === 0) return [];
    let currentOffset = 0;
    return items.map((item, index) => {
      const pct = (item.totalSeconds || item.durationSeconds) / totalSeconds;
      const strokeLength = pct * circumference;
      const strokeDasharray = `${strokeLength} ${circumference - strokeLength}`;
      const strokeDashoffset = -currentOffset;
      currentOffset += strokeLength;
      const color = item.color || COLOR_PALETTE[index % COLOR_PALETTE.length];
      return {
        ...item,
        pct: Math.round(pct * 100),
        color,
        strokeDasharray,
        strokeDashoffset,
      };
    });
  }, [items, totalSeconds, circumference]);

  if (!items || items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500">
        <div className="w-40 h-40 rounded-full border-4 border-dashed border-white/10 flex items-center justify-center">
          <span className="text-xs">No Activity</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative w-52 h-52">
        <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90 transform">
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="transparent"
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth={strokeWidth}
          />
          {slices.map((slice, i) => (
            <circle
              key={slice.name || slice.domain || i}
              cx="100"
              cy="100"
              r={radius}
              fill="transparent"
              stroke={slice.color}
              strokeWidth={activeItem?.name === slice.name || activeItem?.domain === slice.domain ? strokeWidth + 4 : strokeWidth}
              strokeDasharray={slice.strokeDasharray}
              strokeDashoffset={slice.strokeDashoffset}
              className="transition-all duration-200 cursor-pointer hover:opacity-90"
              onMouseEnter={() => setHoveredItem(slice)}
              onMouseLeave={() => setHoveredItem(null)}
              onClick={() => onSelect && onSelect(slice)}
            />
          ))}
        </svg>

        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
            {activeItem?.name || activeItem?.domain ? 'Selected' : label}
          </span>
          <span className="text-xl font-mono font-bold text-white mt-0.5">
            {formatDuration(activeItem ? (activeItem.totalSeconds || activeItem.durationSeconds) : totalSeconds)}
          </span>
          <span className="text-[10px] font-mono text-sky-400">
            {activeItem ? `${activeItem.pct || Math.round(((activeItem.totalSeconds || activeItem.durationSeconds) / (totalSeconds || 1)) * 100)}% of total` : 'Total Active'}
          </span>
        </div>
      </div>

      {/* Selected Item Detail Pill */}
      {activeItem && (
        <div className="mt-3 text-center">
          <p className="text-xs font-semibold text-slate-200 truncate max-w-[220px]">
            {activeItem.name || activeItem.domain}
          </p>
          <div className="flex items-center justify-center gap-2 text-[10px] text-slate-400 mt-0.5">
            <span className="px-1.5 py-0.2 rounded bg-white/5 text-slate-300 font-mono">
              {activeItem.category || 'Other'}
            </span>
            {activeItem.sessionCount !== undefined && (
              <span>&bull; {activeItem.sessionCount} sessions</span>
            )}
            {activeItem.visitCount !== undefined && (
              <span>&bull; {activeItem.visitCount} visits</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DigitalWellbeingPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedRange, setSelectedRange] = useState('7d');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [selectedApp, setSelectedApp] = useState(null);
  const [selectedWeb, setSelectedWeb] = useState(null);

  // Wellbeing break states
  const [breakActive, setBreakActive] = useState(false);
  const [breakTimer, setBreakTimer] = useState(20);
  const [busy, setBusy] = useState(false);

  // Queries
  const fetchSummary = useCallback((opts) => api.summary({ date: selectedDate, userId: selectedEmployeeId || undefined }, opts), [selectedDate, selectedEmployeeId]);
  const fetchApps = useCallback((opts) => api.apps({ date: selectedDate, userId: selectedEmployeeId || undefined }, opts), [selectedDate, selectedEmployeeId]);
  const fetchWebsites = useCallback((opts) => api.websites({ date: selectedDate, userId: selectedEmployeeId || undefined }, opts), [selectedDate, selectedEmployeeId]);
  const fetchWeekly = useCallback((opts) => api.weeklyAnalytics({ range: selectedRange, employeeId: selectedEmployeeId || undefined }, opts), [selectedRange, selectedEmployeeId]);
  const fetchEmployees = useCallback((opts) => api.employees({}, opts), []);
  const fetchPlanner = useCallback((opts) => api.plannerAnalytics(opts), []);
  const fetchWellbeing = useCallback((opts) => api.wellbeingStatus(opts), []);

  const { data: summaryData, loading: sumLoading, error: sumErr, reload: reloadSum } = useApi(fetchSummary, { intervalMs: 5000 });
  const { data: appsData, loading: appsLoading, reload: reloadApps } = useApi(fetchApps, { intervalMs: 5000 });
  const { data: websitesData, loading: webLoading, reload: reloadWeb } = useApi(fetchWebsites, { intervalMs: 5000 });
  const { data: weeklyData, loading: weekLoading, reload: reloadWeek } = useApi(fetchWeekly, { intervalMs: 10000 });
  const { data: plannerData, reload: reloadPlanner } = useApi(fetchPlanner, { intervalMs: 5000 });
  const { data: wellbeingData, reload: reloadWellbeing } = useApi(fetchWellbeing, { intervalMs: 5000 });
  const { data: employeesData } = useApi(fetchEmployees);
  const reportEmployees = employeesData?.employees ?? [];

  const exportCsv = async () => {
    try {
      setExportBusy(true);
      const dayCount = selectedRange === 'today' ? 1 : selectedRange === '30d' ? 30 : 7;
      const end = new Date();
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - (dayCount - 1));
      const blob = await api.exportActivityCsv({
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        employeeId: selectedEmployeeId || undefined,
      });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = 'digitalpulse-activity-report.csv';
      link.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      setSelectedEmployeeId(selectedEmployeeId);
      window.alert(error.message || 'CSV export failed.');
    } finally { setExportBusy(false); }
  };

  const reloadAll = () => {
    reloadSum();
    reloadApps();
    reloadWeb();
    reloadWeek();
    reloadPlanner();
    reloadWellbeing();
  };

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
      reloadWellbeing();
    } catch {
      // safe fallback
    } finally {
      setBusy(false);
    }
  };

  // Aggregated values
  const totalActiveSec = summaryData?.totalActiveSeconds ?? 0;
  const totalIdleSec = summaryData?.totalIdleSeconds ?? 0;
  const totalScreenSec = totalActiveSec + totalIdleSec;
  const dailyTargetMinutes = 360; // 6 hours default target
  const dailyTargetSec = dailyTargetMinutes * 60;
  const usagePercentage = Math.min(100, Math.round((totalScreenSec / dailyTargetSec) * 100));

  const appsList = appsData?.apps ?? [];
  const totalAppSec = appsList.reduce((acc, a) => acc + (a.durationSeconds || a.totalSeconds || 0), 0);

  const websitesList = websitesData?.websites ?? [];
  const totalWebSec = websitesList.reduce((acc, w) => acc + (w.durationSeconds || w.totalSeconds || 0), 0);

  const weeklyDays = weeklyData?.days ?? [];
  const maxWeeklyMins = Math.max(1, ...weeklyDays.map((d) => d.totalActiveMinutes || 1));

  const goals = plannerData?.goalComparisons ?? [];

  if (sumLoading && !summaryData) return <LoadingState label="Loading Digital Wellbeing telemetry…" />;
  if (sumErr) return <ErrorState error={sumErr} onRetry={reloadAll} />;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <PageHeader
            title="Activity reports"
            description="Review recorded active and idle time, application and website usage, and daily trends."
          />
          <p className="text-xs text-sky-400 mt-1 font-mono">
            Date filter: <span className="font-bold text-white">{selectedDate === new Date().toISOString().split('T')[0] ? 'Today (Live)' : selectedDate}</span>
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 font-mono focus:border-sky-400 focus:outline-none"
          />
          <select aria-label="Filter reports by employee" value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)} className="rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100">
            <option value="">All accessible employees</option>
            {reportEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}
          </select>
          <Button onClick={exportCsv} disabled={exportBusy} className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs">{exportBusy ? 'Exporting…' : 'Export CSV'}</Button>
        </div>
      </div>

      {/* Full-Screen Eye Break Overlay if active */}
      {breakActive && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-md p-6 text-center text-white">
          <div className="grid h-24 w-24 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 mb-6 animate-pulse">
            <HeartIcon width={48} height={48} />
          </div>
          <h2 className="text-3xl font-bold">20-20-20 Eye Rest</h2>
          <p className="mt-2 text-slate-300 max-w-md">
            Look away from your screen at an object at least 20 feet (6 meters) away to relax your ciliary eye muscles.
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

      {/* SECTION 1.A: TODAY'S SCREEN TIME DASHBOARD */}
      <div className="my-6 rounded-2xl border border-white/10 bg-gradient-to-br from-surface-900 to-slate-950 p-6 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-white/5">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-sky-400">Screen Time Telemetry</span>
            <div className="flex items-baseline gap-3 mt-1">
              <h2 className="text-4xl font-extrabold text-white font-mono">
                {formatDuration(totalScreenSec)}
              </h2>
              <span className="text-xs text-slate-400">
                Daily Target: <strong className="text-slate-200">6h 00m</strong>
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Active: <strong className="text-emerald-400">{formatDuration(totalActiveSec)}</strong> &bull; Idle: <strong className="text-amber-400">{formatDuration(totalIdleSec)}</strong>
            </p>
          </div>

          {/* Goal Progress Ring / Bar */}
          <div className="lg:w-80">
            <div className="flex justify-between items-center text-xs mb-1.5">
              <span className="text-slate-400">Daily Target Consumed</span>
              <span className="font-mono font-bold text-sky-400">{usagePercentage}%</span>
            </div>
            <div className="h-3 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  usagePercentage > 100 ? 'bg-rose-500' : usagePercentage >= 80 ? 'bg-amber-500' : 'bg-sky-500'
                }`}
                style={{ width: `${Math.min(100, usagePercentage)}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {totalScreenSec > dailyTargetSec
                ? `Exceeded daily limit by ${formatDuration(totalScreenSec - dailyTargetSec)}`
                : `${formatDuration(dailyTargetSec - totalScreenSec)} remaining today`}
            </p>
          </div>
        </div>

        {/* Telemetry Metrics Row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 pt-6">
          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">App Sessions</p>
            <p className="text-2xl font-bold font-mono text-white mt-1">
              {summaryData?.appSessionCount ?? summaryData?.today?.appCount ?? 0}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Focus switches tracked</p>
          </div>

          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Website Sessions</p>
            <p className="text-2xl font-bold font-mono text-sky-400 mt-1">
              {summaryData?.webSessionCount ?? summaryData?.today?.websiteCount ?? 0}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Browser domains visited</p>
          </div>

          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Screen Unlocks</p>
            <p className="text-base font-semibold text-slate-400 mt-1">
              Not Available
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Windows endpoint constraint</p>
          </div>

          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">System Notifications</p>
            <p className="text-base font-semibold text-slate-400 mt-1">
              Not Available
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Collector not authorized</p>
          </div>
        </div>
      </div>

      {/* SECTION 1.D: WEEKLY SCREEN TIME CHART (Sunday through Saturday) */}
      <Card title="Screen Time Trend & Daily Comparison">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-4 text-xs">
            <div>
              <span className="text-slate-400">Daily Average: </span>
              <strong className="text-white font-mono">{formatDuration((weeklyData?.summary?.averageDailyMinutes || 0) * 60)}</strong>
            </div>
            <div>
              <span className="text-slate-400">Peak Day: </span>
              <strong className="text-emerald-400 font-mono">
                {weeklyData?.summary?.highestUsageDay?.dayName || '—'} ({formatDuration((weeklyData?.summary?.highestUsageDay?.minutes || 0) * 60)})
              </strong>
            </div>
            <div>
              <span className="text-slate-400">Lowest Day: </span>
              <strong className="text-sky-300 font-mono">
                {weeklyData?.summary?.lowestUsageDay?.dayName || '—'} ({formatDuration((weeklyData?.summary?.lowestUsageDay?.minutes || 0) * 60)})
              </strong>
            </div>
          </div>

          {/* Range Switcher */}
          <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1 text-xs">
            {['today', '7d', '30d'].map((r) => (
              <button
                key={r}
                onClick={() => setSelectedRange(r)}
                className={`px-3 py-1 rounded font-medium transition ${
                  selectedRange === r ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                {r === 'today' ? 'Today' : r === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
              </button>
            ))}
          </div>
        </div>

        {/* Weekly Bar Chart */}
        {weeklyDays.length === 0 ? (
          <EmptyState title="No historical trend recorded">
            Daily usage will populate as the desktop agent monitors foreground sessions.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            <div className="flex items-end gap-2 h-44 pt-6 px-2 border-b border-white/5">
              {weeklyDays.map((day) => {
                const heightPct = Math.min(100, Math.round(((day.totalActiveMinutes || 1) / maxWeeklyMins) * 100));
                const isSelected = selectedDate === day.date;
                return (
                  <div
                    key={day.date}
                    onClick={() => setSelectedDate(day.date)}
                    className="flex-1 flex flex-col items-center h-full justify-end group cursor-pointer"
                    title={`${day.date} (${day.dayName}): ${formatDuration(day.totalActiveMinutes * 60)} active`}
                  >
                    <div className="text-[10px] font-mono text-slate-400 opacity-0 group-hover:opacity-100 transition mb-1">
                      {Math.round(day.totalActiveMinutes)}m
                    </div>
                    <div
                      className={`w-full max-w-[36px] rounded-t-md transition-all duration-300 ${
                        isSelected
                          ? 'bg-sky-400 shadow-lg shadow-sky-500/30'
                          : 'bg-slate-700 hover:bg-sky-500/70'
                      }`}
                      style={{ height: `${Math.max(8, heightPct)}%` }}
                    />
                    <span className={`text-[11px] font-mono mt-2 ${isSelected ? 'text-sky-400 font-bold' : 'text-slate-400'}`}>
                      {day.dayName}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 text-center pt-2">
              Click any bar to inspect application & website breakdowns for that specific date.
            </p>
          </div>
        )}
      </Card>

      {/* SECTION 1.B & 1.C: INTERACTIVE DONUT CHARTS (APPS & WEBSITES) */}
      <div className="grid gap-6 lg:grid-cols-2 my-6">
        {/* Application Usage Donut */}
        <Card title="Application Usage Breakdown">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <DonutChart
              items={appsList}
              totalSeconds={totalAppSec}
              label="Applications"
              onSelect={setSelectedApp}
              selectedItem={selectedApp}
            />

            <div className="flex-1 w-full max-h-60 overflow-y-auto space-y-2 pr-1">
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block mb-2">
                Top Applications ({appsList.length})
              </span>
              {appsList.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No application activity recorded for {selectedDate}.</p>
              ) : (
                appsList.slice(0, 7).map((app, i) => (
                  <div
                    key={app.name || app.executable}
                    onClick={() => setSelectedApp(app)}
                    className={`flex items-center justify-between p-2 rounded-lg text-xs cursor-pointer transition ${
                      selectedApp?.name === app.name ? 'bg-sky-500/20 border border-sky-500/30' : 'bg-white/[0.02] hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: COLOR_PALETTE[i % COLOR_PALETTE.length] }}
                      />
                      <div className="truncate">
                        <p className="font-semibold text-slate-200 truncate">{app.name}</p>
                        <span className="text-[10px] text-slate-500 font-mono">{app.category || 'Productivity'}</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 font-mono">
                      <p className="text-emerald-400 font-bold">{formatDuration(app.totalSeconds || app.durationSeconds)}</p>
                      <span className="text-[10px] text-slate-400">{app.percentage}%</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>

        {/* Website Usage Donut */}
        <Card title="Website Usage Breakdown">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <DonutChart
              items={websitesList}
              totalSeconds={totalWebSec}
              label="Websites"
              onSelect={setSelectedWeb}
              selectedItem={selectedWeb}
            />

            <div className="flex-1 w-full max-h-60 overflow-y-auto space-y-2 pr-1">
              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block mb-2">
                Top Domains ({websitesList.length})
              </span>
              {websitesList.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No browser domain activity recorded for {selectedDate}.</p>
              ) : (
                websitesList.slice(0, 7).map((web, i) => (
                  <div
                    key={web.domain}
                    onClick={() => setSelectedWeb(web)}
                    className={`flex items-center justify-between p-2 rounded-lg text-xs cursor-pointer transition ${
                      selectedWeb?.domain === web.domain ? 'bg-sky-500/20 border border-sky-500/30' : 'bg-white/[0.02] hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: COLOR_PALETTE[i % COLOR_PALETTE.length] }}
                      />
                      <div className="truncate">
                        <p className="font-semibold text-slate-200 truncate">{web.domain}</p>
                        <span className="text-[10px] text-slate-500 font-mono">{web.category || 'General'}</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 font-mono">
                      <p className="text-sky-400 font-bold">{formatDuration(web.totalSeconds || web.durationSeconds)}</p>
                      <span className="text-[10px] text-slate-400">{web.percentage}%</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* SECTION 1.E: USAGE PERCENTAGE & GOAL PROGRESS CARDS */}
      <Card title="Daily Limits & Goal Adherence">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {goals.map((g) => {
            const actualMins = g.actualMinutes || 0;
            const maxMins = g.maxMinutesPerDay || 180;
            const pct = Math.min(100, Math.round((actualMins / maxMins) * 100));
            const isExceeded = actualMins > maxMins;
            const isWarning = pct >= (g.warningThresholdPercent || 80);

            return (
              <div key={g.title} className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-2">
                <div className="flex justify-between items-start">
                  <h4 className="text-xs font-semibold text-slate-200 leading-tight">{g.title}</h4>
                  <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                    isExceeded ? 'bg-rose-500/20 text-rose-300' : isWarning ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'
                  }`}>
                    {pct}%
                  </span>
                </div>

                <div className="flex justify-between items-baseline text-xs font-mono">
                  <span className={isExceeded ? 'text-rose-400 font-bold' : isWarning ? 'text-amber-400 font-bold' : 'text-slate-100 font-bold'}>
                    {formatDuration(actualMins * 60)}
                  </span>
                  <span className="text-slate-500">/ {formatDuration(maxMins * 60)}</span>
                </div>

                <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isExceeded ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <p className="text-[10px] text-slate-500">
                  {isExceeded
                    ? `Exceeded limit by ${formatDuration((actualMins - maxMins) * 60)}`
                    : `${formatDuration((maxMins - actualMins) * 60)} remaining`}
                </p>
              </div>
            );
          })}
          {goals.length === 0 && <EmptyState title="No configured limits">No organization limits are configured for this date.</EmptyState>}
        </div>
      </Card>

      {/* ERGONOMICS & HEALTH GUIDANCE (Preserved Section) */}
      <div className="grid gap-6 lg:grid-cols-2 my-6">
        <Card title="The 20-20-20 Eye Strain Rule">
          <div className="space-y-4">
            <p className="text-xs text-slate-300 leading-relaxed">
              Prolonged close-up screen focus reduces blink rate by over 60%, causing computer vision syndrome
              and headaches. Every 20 minutes, DigitalPulse reminds you to look at least 20 feet away for 20 seconds.
            </p>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Current Eye Rest Interval:</span>
                <span className="font-mono text-emerald-400">Every 20 minutes</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Breaks Completed Today:</span>
                <span className="font-mono font-bold text-white">{wellbeingData?.breaksCompletedToday ?? 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Last Break:</span>
                <span className="font-mono text-slate-300">
                  {wellbeingData?.lastBreakTakenAt ? new Date(wellbeingData.lastBreakTakenAt).toLocaleTimeString() : 'Earlier today'}
                </span>
              </div>
            </div>
            <Button onClick={startEyeBreak} disabled={breakActive} className="w-full text-xs">
              Start 20s Eye Break Exercise
            </Button>
          </div>
        </Card>

        <Card title="Ergonomics & Posture Guidance">
          <div className="space-y-2.5 text-xs text-slate-300">
            <div className="flex items-start gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <span className="text-emerald-400 font-bold text-sm">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">Screen Height Alignment</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">The top third of display should align with eye level to minimize cervical neck flexion.</p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <span className="text-emerald-400 font-bold text-sm">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">90-Degree Elbow & Knee Angles</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">Keep forearms parallel to desk and feet flat on the floor to prevent repetitive strain.</p>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <span className="text-emerald-400 font-bold text-sm">✓</span>
              <div>
                <h4 className="font-semibold text-slate-100">Hydration & Movement</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">Stand up, stretch back muscles, and drink a glass of water every 60 minutes.</p>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
