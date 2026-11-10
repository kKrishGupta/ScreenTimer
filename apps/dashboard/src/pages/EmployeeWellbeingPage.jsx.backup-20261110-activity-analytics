import { useCallback, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';
import { DonutChart } from './DigitalWellbeingPage.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const REFRESH_INTERVAL_MS = 30000;

function UsageBreakdown({ title, items }) {
  const totalSeconds = items.reduce((sum, item) => sum + item.totalSeconds, 0);

  return (
    <Card title={title}>
      {items.length ? (
        <>
          <DonutChart items={items} totalSeconds={totalSeconds} label="Recorded time" />
          <ul className="mt-4 space-y-2">
            {items.map((item) => (
              <li key={item.name} className="flex justify-between gap-3 text-sm text-slate-300">
                <span className="break-all">{item.name}</span>
                <span>{formatDuration(item.totalSeconds)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-slate-400">
          No recorded usage for this category.
        </p>
      )}
    </Card>
  );
}

function EmployeeDetails({ employeeId, organizationId }) {
  const loadEmployee = useCallback(
    (opts) => api.employee(encodeURIComponent(employeeId), { ...opts, organizationId }),
    [employeeId, organizationId]
  );

  const detailsRequest = useApi(loadEmployee, {
    intervalMs: REFRESH_INTERVAL_MS,
  });

  const responseEmployee = detailsRequest.data?.employee;
  const employee = responseEmployee?.id === employeeId
    ? responseEmployee
    : null;
  const analytics = employee?.analytics;

  const websites = (analytics?.websiteUsage || []).map((item) => ({
    name: item.name,
    totalSeconds: item.seconds || 0,
  }));

  const applications = (analytics?.applicationUsage || []).map((item) => ({
    name: item.name,
    totalSeconds: item.seconds || 0,
  }));

  const topWebsite = [...websites]
    .sort((a, b) => b.totalSeconds - a.totalSeconds)[0]?.name;

  return (
    <>
      {detailsRequest.error ? (
        <ErrorState error={detailsRequest.error} onRetry={detailsRequest.reload} />
      ) : !employee ? (
        <LoadingState label="Loading employee wellbeing..." />
      ) : analytics?.hasData !== true ? (
        <EmptyState title="No usage recorded today">
          Activity will appear after an authorized employee device synchronizes.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title="Recorded active time">
              <p className="text-3xl font-semibold text-emerald-300">
                {formatDuration(analytics.activeSeconds || 0)}
              </p>
            </Card>
            <Card title="Recorded idle time">
              <p className="text-3xl font-semibold text-amber-300">
                {formatDuration(analytics.idleSeconds || 0)}
              </p>
            </Card>
            <Card title="Most-used website">
              <p className="break-all text-xl font-semibold text-sky-300">
                {topWebsite || 'No website usage'}
              </p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <UsageBreakdown title="Website usage breakdown" items={websites} />
            <UsageBreakdown title="Application usage breakdown" items={applications} />
          </div>
        </>
      )}

      <Card title="About this summary">
        <p className="text-sm text-slate-300">
          This page displays today's synchronized activity for the selected employee.
          Untracked time is not counted as idle time. Data refreshes every
          30 seconds while the page is visible.
        </p>
      </Card>
    </>
  );
}
function ScopedEmployeeWellbeing({ organizationId, isSuperAdmin }) {
  const [selectedId, setSelectedId] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  const loadEmployees = useCallback(
    (opts) => api.employees(
      isSuperAdmin ? { organizationId } : {},
      opts
    ),
    [organizationId, isSuperAdmin]
  );

  const employeesRequest = useApi(loadEmployees, {
    intervalMs: REFRESH_INTERVAL_MS,
  });

  const employees = useMemo(
    () => employeesRequest.data?.employees || [],
    [employeesRequest.data]
  );

  const effectiveId = employees.some((item) => item.id === selectedId)
    ? selectedId
    : employees[0]?.id || '';

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => {
          employeesRequest.reload();
          setRefreshVersion((version) => version + 1);
        }}>
          Refresh
        </Button>
      </div>

      {employeesRequest.loading && !employeesRequest.data ? (
        <LoadingState label="Loading employees..." />
      ) : employeesRequest.error ? (
        <ErrorState error={employeesRequest.error} onRetry={employeesRequest.reload} />
      ) : employees.length === 0 ? (
        <EmptyState title="No employees found">
          No employees are available in the selected organization.
        </EmptyState>
      ) : (
        <>
          <Card title="Select employee">
            <select
              value={effectiveId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white"
              aria-label="Select employee"
            >
              {employees.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName || item.companyEmail || item.employeeId || item.id}
                </option>
              ))}
            </select>
          </Card>

          <EmployeeDetails
            key={`${organizationId || 'admin'}:${effectiveId}:${refreshVersion}`}
            employeeId={effectiveId}
            organizationId={isSuperAdmin ? organizationId : undefined}
          />
        </>
      )}
    </>
  );
}

export default function EmployeeWellbeingPage() {
  const { user, selectedOrganizationId } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const organizationId = isSuperAdmin
    ? selectedOrganizationId
    : user?.organizationId;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employee Wellbeing"
        description="Today's recorded activity and digital wellbeing for employees."
      />

      {isSuperAdmin && !organizationId ? (
        <EmptyState title="Select an organization">
          Choose an organization from the Admin Console header.
        </EmptyState>
      ) : (
        <ScopedEmployeeWellbeing
          key={organizationId || 'admin'}
          organizationId={organizationId}
          isSuperAdmin={isSuperAdmin}
        />
      )}
    </div>
  );
}