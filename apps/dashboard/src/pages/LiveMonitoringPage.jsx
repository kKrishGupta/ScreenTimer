import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';

function timeAgo(dateString) {
  if (!dateString) return 'Never';
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 15) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export default function LiveMonitoringPage() {
  const fetchLive = useCallback((opts) => api.liveEmployees({}, opts), []);
  const { data, error, loading, reload } = useApi(fetchLive, { intervalMs: 15_000, staleTimeMs: 10_000, queryKey: 'employees-live' });

  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const employees = data?.employees || [];
  const summary = data?.summary || {
    totalEmployees: employees.length,
    activeCount: employees.filter((e) => e.liveStatus === 'WORKING' || e.liveStatus === 'ACTIVE').length,
    idleCount: employees.filter((e) => e.liveStatus === 'IDLE').length,
    offlineCount: employees.filter((e) => e.liveStatus === 'OFFLINE').length,
  };

  const departments = useMemo(() => {
    const set = new Set();
    employees.forEach((e) => {
      if (e.department) set.add(e.department);
    });
    return Array.from(set).sort();
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    return employees.filter((emp) => {
      if (departmentFilter !== 'ALL' && emp.department !== departmentFilter) {
        return false;
      }
      if (statusFilter !== 'ALL' && emp.liveStatus !== statusFilter) {
        return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchesName = emp.displayName?.toLowerCase().includes(q);
        const matchesEmail = emp.email?.toLowerCase().includes(q);
        const matchesApp = emp.currentApplication?.toLowerCase().includes(q);
        const matchesDomain = emp.currentDomain?.toLowerCase().includes(q);
        const matchesDept = emp.department?.toLowerCase().includes(q);
        if (!matchesName && !matchesEmail && !matchesApp && !matchesDomain && !matchesDept) {
          return false;
        }
      }
      return true;
    });
  }, [employees, departmentFilter, statusFilter, search]);

  if (loading && !data) {
    return <LoadingState label="Connecting to live endpoint telemetry stream…" />;
  }

  if (error || data?.error) {
    return (
      <ErrorState
        error={error || new Error(data?.error?.message || 'Unable to retrieve live telemetry')}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live Employee Activity & Endpoint Monitor"
        description="Real-time foreground applications, domain navigation, active/idle states, and workstation telemetries."
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
            </span>
            Live Telemetry Active
          </div>
          <Button onClick={reload} className="text-xs">
            Refresh Now
          </Button>
        </div>
      </PageHeader>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-surface-900/80 p-4">
          <div className="text-xs font-medium text-slate-400">Total Monitored</div>
          <div className="mt-2 text-2xl font-bold text-white">{summary.totalEmployees}</div>
          <div className="mt-1 text-xs text-slate-500">Enrolled workstations</div>
        </div>

        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-emerald-400">Active Now</span>
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-300">{summary.activeCount}</div>
          <div className="mt-1 text-xs text-emerald-500/80">Foreground active</div>
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-amber-400">Idle Now</span>
            <span className="h-2 w-2 rounded-full bg-amber-400"></span>
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-300">{summary.idleCount}</div>
          <div className="mt-1 text-xs text-amber-500/80">&gt; 30s input pause</div>
        </div>

        <div className="rounded-xl border border-slate-700/40 bg-surface-900/80 p-4">
          <div className="text-xs font-medium text-slate-400">Offline Endpoints</div>
          <div className="mt-2 text-2xl font-bold text-slate-300">{summary.offlineCount}</div>
          <div className="mt-1 text-xs text-slate-500">&gt; 5m no heartbeat</div>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by employee, email, application, or domain…"
              className="w-full rounded-lg border border-white/10 bg-surface-800 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-accent-400 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-surface-800 px-3 py-1.5 text-xs text-slate-200 focus:border-accent-400 focus:outline-none"
            >
              <option value="ALL">All Departments</option>
              {departments.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-surface-800 px-3 py-1.5 text-xs text-slate-200 focus:border-accent-400 focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="WORKING">Working</option>
              <option value="IDLE">Idle Workstations</option>
              <option value="OFFLINE">Offline Devices</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Live Monitoring Table */}
      <Card>
        {filteredEmployees.length === 0 ? (
          <EmptyState title="No employees match criteria">
            {search || departmentFilter !== 'ALL' || statusFilter !== 'ALL'
              ? 'Try clearing the search query or adjusting department and status filters.'
              : 'No enrolled employee endpoints are streaming data. Start the Windows agent on employee devices to populate live telemetry.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="pb-3 font-semibold">Employee</th>
                  <th className="pb-3 font-semibold">Device</th>
                  <th className="pb-3 font-semibold">Live State</th>
                  <th className="pb-3 font-semibold">Current Application</th>
                  <th className="pb-3 font-semibold">Current Domain</th>
                  <th className="pb-3 font-semibold">Active Time Today</th>
                  <th className="pb-3 font-semibold">Last Update</th>
                  <th className="pb-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredEmployees.map((emp) => (
                  <tr key={emp.id} className="transition hover:bg-white/[0.02]">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-white">{emp.displayName}</div>
                      <div className="text-[11px] text-slate-400">{emp.email}</div>
                      <span className="mt-0.5 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {emp.department}
                      </span>
                    </td>

                    <td className="py-3 pr-4 font-mono text-[11px] text-slate-300">
                      {emp.device?.name || (emp.liveStatus === 'NOT_ENROLLED' ? 'Not enrolled' : 'No recent device')}
                      <div className="text-[10px] text-slate-500 uppercase">
                        {emp.device?.kind ? emp.device.kind.replace('_', ' ') : 'Desktop'}
                      </div>
                    </td>

                    <td className="py-3 pr-4">
                      {(emp.liveStatus === 'WORKING' || emp.liveStatus === 'ACTIVE') && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                          Working
                        </span>
                      )}
                      {emp.liveStatus === 'IDLE' && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                          Idle
                        </span>
                      )}
                      {emp.liveStatus === 'OFFLINE' && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 font-medium text-slate-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-500"></span>
                          Offline
                        </span>
                      )}
                      {emp.liveStatus === 'NOT_ENROLLED' && <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300">Not enrolled</span>}
                    </td>

                    <td className="py-3 pr-4 font-medium text-slate-200">
                      {emp.currentApplication && emp.currentApplication !== 'None' ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm bg-accent-400"></span>
                          {emp.currentApplication}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>

                    <td className="py-3 pr-4 font-mono text-slate-300">
                      {emp.currentDomain && emp.currentDomain !== 'None' ? (
                        <span className="text-sky-400">{emp.currentDomain}</span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>

                    <td className="py-3 pr-4 font-medium text-slate-300">
                      {emp.activeTimeFormatted}
                    </td>

                    <td className="py-3 pr-4 text-slate-400">
                      {timeAgo(emp.lastSeen)}
                    </td>

                    <td className="py-3 text-right">
                      <Link
                        to={`/timeline?employeeId=${emp.id}`}
                        className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition hover:border-accent-400 hover:text-white"
                      >
                        Timeline
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

