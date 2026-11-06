import { useCallback, useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { UsersIcon, DeviceIcon } from '../components/ui/icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function EmployeesPage() {
  const { user } = useAuth();
  const canAuthorizeMonitoring = user?.role === 'ADMIN';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('EMPLOYEE');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteDepartment, setInviteDepartment] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteCreated, setInviteCreated] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(null);
  const [invitationLinks, setInvitationLinks] = useState({});
  const [copyToast, setCopyToast] = useState('');
  const inviteSubmittingRef = useRef(false);
  const [newEmployeeLink, setNewEmployeeLink] = useState('');
  const [newEmployeeCreated, setNewEmployeeCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authorizationMessage, setAuthorizationMessage] = useState('');
  const [setupReminder, setSetupReminder] = useState(null);
  const setupReminderSubmittingRef = useRef(false);

  // New employee form state
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newEmpId, setNewEmpId] = useState('');
  const [newDept, setNewDept] = useState('Engineering');
  const [newDesignation, setNewDesignation] = useState('Software Engineer');
  const [newLocation, setNewLocation] = useState('Remote');
  const [newShiftStart, setNewShiftStart] = useState('09:00');
  const [newShiftEnd, setNewShiftEnd] = useState('18:00');

  const fetchEmployees = useCallback((opts) => api.employees({
    search: search.trim() || undefined,
    department: deptFilter || undefined,
    status: statusFilter || undefined,
  }, opts), [search, deptFilter, statusFilter]);

  const fetchDevices = useCallback((opts) => api.devices(opts), []);

  const { data, error, loading, reload } = useApi(fetchEmployees, { intervalMs: 5000 });
  const { data: devicesData } = useApi(fetchDevices, { intervalMs: 5000 });
  const fetchInvitations = useCallback((opts) => api.invitations(opts), []);
  const { data: invitationsData, reload: reloadInvitations } = useApi(fetchInvitations, { intervalMs: 10000 });
  const invitations = invitationsData?.invitations ?? [];

  useEffect(() => {
    if (!selectedEmployee?.id) return;
    let cancelled = false;
    api.employee(selectedEmployee.id).then((result) => {
      if (!cancelled && result?.employee) setSelectedEmployee(result.employee);
    }).catch((err) => {
      if (!cancelled) setInviteError(err.message || 'Could not load employee profile.');
    });
    return () => { cancelled = true; };
  }, [selectedEmployee?.id]);

  // Immediately reload when search or filter changes
  useEffect(() => {
    reload();
  }, [search, deptFilter, statusFilter, reload]);

  const employees = data?.employees ?? [];
  const allDevices = devicesData?.devices ?? [];
  const profileDevices = selectedEmployee?.devices ?? [];
  const agentDevice = profileDevices.find((device) => String(device.kind).toUpperCase() === 'DESKTOP_AGENT');
  const extensionDevice = profileDevices.find((device) => String(device.kind).toUpperCase() === 'BROWSER_EXTENSION');

  const handleCreateEmployee = async (e) => {
    e.preventDefault();
    if (!newFirstName.trim() || !newEmail.trim() || newEmployeeCreated) return;
    try {
      setBusy(true);
      const result = await api.createEmployee({
        firstName: newFirstName.trim(),
        lastName: newLastName.trim(),
        displayName: `${newFirstName.trim()} ${newLastName.trim()}`.trim(),
        companyEmail: newEmail.trim(),
        department: newDept,
        shiftStart: newShiftStart,
        shiftEnd: newShiftEnd,
        workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        shiftTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      setNewEmployeeLink(result.invitationUrl || '');
      setNewEmployeeCreated(true);
      setInviteError(result.emailSent ? 'Invitation email sent. The account is created after acceptance.' : 'Email delivery is unavailable. The invitation is active; copy the link below to complete onboarding.');
      reload();
      reloadInvitations();
    } catch (err) {
      setInviteError(err.message || 'Could not start employee onboarding.');
    } finally {
      setBusy(false);
    }
  };

  const handleMonitoringAuthorization = async (authorized) => {
    if (!selectedEmployee?.id || busy) return;
    setBusy(true);
    setAuthorizationMessage('');
    try {
      await api.setEmployeeMonitoringAuthorization(selectedEmployee.id, authorized);
      const result = await api.employee(selectedEmployee.id);
      if (result?.employee) setSelectedEmployee(result.employee);
      reload();
      setAuthorizationMessage(authorized ? 'Monitoring authorization granted.' : 'Monitoring authorization revoked. Collection will pause.');
    } catch (err) {
      setAuthorizationMessage(err.message || 'Monitoring authorization could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const handleInviteEmployee = async (e) => {
    e.preventDefault();
    if (inviteSubmittingRef.current || busy || inviteCreated) return;
    if (!inviteName.trim() || !inviteEmail.trim() || !inviteDepartment.trim() || !newShiftStart || !newShiftEnd) {
      setInviteError('Enter the employee name, email, department, and working hours.');
      return;
    }
    inviteSubmittingRef.current = true;
    try {
      setBusy(true);
      const result = await api.inviteEmployee({
        email: inviteEmail.trim(), displayName: inviteName.trim(), role: inviteRole,
        departmentId: undefined, department: inviteDepartment.trim() || undefined,
        shiftStart: newShiftStart, shiftEnd: newShiftEnd,
        workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        shiftTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      if (!result.invitationUrl || !result.invitation?.id) throw new Error('The invitation was saved, but the server did not return its secure link. Use Resend Invitation to create a fresh link.');
      setInviteLink(result.invitationUrl || '');
      setInviteCreated(true);
      setInviteSuccess({
        invitation: { ...result.invitation, email: result.invitation.email || inviteEmail.trim(), displayName: result.invitation.displayName || inviteName.trim() },
        invitationUrl: result.invitationUrl,
        expiresAt: result.expiresAt,
        emailSent: Boolean(result.emailSent),
      });
      setInvitationLinks((current) => ({ ...current, [result.invitation.id]: result.invitationUrl }));
      setInviteError('');
      reload();
      reloadInvitations();
    } catch (err) {
      setInviteError(err.message || 'Could not create the invitation.');
    } finally {
      inviteSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const handleCopyInvitationLink = async (url) => {
    if (!url) {
      setCopyToast('This one-time link is not stored. Resend the invitation to create a fresh copyable link.');
      window.setTimeout(() => setCopyToast(''), 3500);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopyToast('Invitation link copied.');
    } catch {
      setCopyToast('Clipboard access failed. Select and copy the invitation link above.');
    }
    window.setTimeout(() => setCopyToast(''), 3500);
  };

  const retryInvitationEmail = async (invitationId) => {
    try {
      setBusy(true);
      const result = await api.resendInvitation(invitationId);
      if (!result.invitationUrl) throw new Error('The link could not be regenerated. Try again.');
      setInviteLink(result.invitationUrl);
      setInviteSuccess({
        invitation: result.invitation,
        invitationUrl: result.invitationUrl,
        expiresAt: result.expiresAt,
        emailSent: Boolean(result.emailSent),
      });
      setInvitationLinks((current) => ({ ...current, [result.invitation.id]: result.invitationUrl }));
      setInviteError('');
      setCopyToast(result.emailSent ? 'A fresh invitation email was sent.' : 'Email is still unavailable. The active invitation link has been refreshed.');
      reloadInvitations();
    } catch (err) {
      setInviteError(err.message || 'Could not retry invitation email.');
    } finally {
      setBusy(false);
    }
  };

  const handleInvitationAction = async (action, invitationId) => {
    try {
      setBusy(true);
      if (action === 'revoke' && !window.confirm('Revoke this invitation? Its link will stop working.')) return;
      if (action === 'revoke') await api.revokeInvitation(invitationId);
      else {
        const result = await api.resendInvitation(invitationId);
        setInviteLink(result.invitationUrl || '');
        setInviteCreated(true);
        setInviteSuccess({ invitation: result.invitation, invitationUrl: result.invitationUrl, expiresAt: result.expiresAt, emailSent: Boolean(result.emailSent) });
        if (result.invitationUrl) setInvitationLinks((current) => ({ ...current, [invitationId]: result.invitationUrl }));
        setShowInviteModal(true);
        setInviteError('');
      }
      reloadInvitations();
    } catch (err) {
      setInviteError(err.message || 'Invitation update failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignDevice = async (empId, deviceId) => {
    try {
      setBusy(true);
      await api.assignEmployeeDevice(empId, deviceId);
      reload();
      if (selectedEmployee) {
        const updated = await api.employee(selectedEmployee.id);
        setSelectedEmployee(updated.employee);
      }
    } catch (err) {
      alert(`Error assigning device: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEmployee = async (id) => {
    if (!confirm('Are you sure you want to deactivate and remove this employee profile?')) return;
    try {
      setBusy(true);
      await api.deleteEmployee(id);
      if (selectedEmployee?.id === id) setSelectedEmployee(null);
      reload();
    } catch (err) {
      alert(`Error removing employee: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleInviteEmployeeToSetup = async () => {
    if (!selectedEmployee?.id || setupReminderSubmittingRef.current) return;
    setupReminderSubmittingRef.current = true;
    setSetupReminder(null);
    try {
      setBusy(true);
      const result = await api.employeeSetupReminder(selectedEmployee.id);
      if (!result?.success || !['sent', 'queued', 'already_queued'].includes(result.deliveryStatus)) {
        throw new Error(result?.message || 'The backend did not confirm the setup reminder.');
      }
      if (result.deliveryStatus === 'queued' && result.setupUrl) {
        try { await navigator.clipboard?.writeText(result.setupUrl); } catch { /* show the copyable link below */ }
      }
      setSetupReminder({
        message: result.message || (result.deliveryStatus === 'sent'
          ? `Setup instructions sent to ${selectedEmployee.email}.`
          : result.deliveryStatus === 'already_queued'
            ? 'A setup reminder was already queued recently; no duplicate was sent.'
            : 'Email is unavailable. The setup reminder was queued in DigitalPulse.'),
        url: result.deliveryStatus === 'queued' ? result.setupUrl : '',
      });
      const refreshes = await Promise.allSettled([
        api.employee(selectedEmployee.id),
        reload(),
        reloadInvitations(),
      ]);
      if (refreshes[0].status === 'fulfilled' && refreshes[0].value?.employee) {
        setSelectedEmployee(refreshes[0].value.employee);
      }
    } catch (err) {
      const message = err.status === 404
        ? 'The backend is running an older route set. Restart the DigitalPulse backend, then try again.'
        : err.message || 'Could not send device setup instructions.';
      setSetupReminder({ message, showGuide: err.status === 404 });
    } finally {
      setupReminderSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading employee directory…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Employee Directory & Monitoring Governance"
          description="Manage enterprise employee profiles, assigned endpoint devices, shift schedules, and monitoring authorization."
        />
        <div className="flex gap-2">
          <Button onClick={() => { setInviteError(''); setInviteLink(''); setInviteCreated(false); setInviteSuccess(null); setShowInviteModal(true); }} className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs">
            + Invite Employee
          </Button>
          <Button onClick={() => { setInviteError(''); setNewEmployeeLink(''); setNewEmployeeCreated(false); setShowAddModal(true); }} className="bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs">
            + Add New Employee
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Employees', data?.counts?.total ?? employees.length, 'text-white'],
          ['Online', data?.counts?.online ?? employees.filter((e) => e.connectionStatus === 'ONLINE').length, 'text-emerald-400'],
          ['Offline', data?.counts?.offline ?? employees.filter((e) => e.connectionStatus === 'OFFLINE').length, 'text-slate-200'],
          ['Pending', data?.counts?.pending ?? employees.filter((e) => e.accountStatus !== 'ACTIVE' || e.connectionStatus === 'PENDING_ENROLLMENT').length, 'text-amber-300'],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
            <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filter and Search Bar */}
      <div className="my-6 flex flex-wrap items-center gap-3 bg-surface-900/60 p-3.5 rounded-xl border border-white/5">
        <input
          type="text"
          placeholder="Search by name, ID, email, or department..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
        />

        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-200"
        >
          <option value="">All Departments</option>
          <option value="Engineering">Engineering</option>
          <option value="Product Design">Product Design</option>
          <option value="DevOps & Infrastructure">DevOps & Infrastructure</option>
          <option value="Marketing">Marketing</option>
          <option value="Sales">Sales</option>
          <option value="Support">Support</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-200"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="on_leave">On Leave</option>
          <option value="terminated">Terminated</option>
        </select>

        {(search || deptFilter || statusFilter !== 'active') && (
          <button
            onClick={() => { setSearch(''); setDeptFilter(''); setStatusFilter('active'); }}
            className="text-xs text-slate-400 hover:text-white px-2 py-1"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Employee Grid / Table */}
      {employees.length === 0 ? (
        <div className="flex flex-col items-center">
          <EmptyState title="No employees found">
            No employee records match the selected filters. Click below to enroll a new employee.
          </EmptyState>
          <Button onClick={() => setShowAddModal(true)} className="mt-4 bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs">
            + Add New Employee
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {employees.map((emp) => {
            const isOnline = emp.currentAgentStatus === 'ONLINE';
            const isEnrolled = emp.deviceCount > 0;

            return (
              <div
                key={emp.id}
                onClick={() => setSelectedEmployee(emp)}
                className={`group rounded-xl border p-4 cursor-pointer transition-all ${
                  selectedEmployee?.id === emp.id
                    ? 'border-sky-500 bg-sky-950/20 shadow-lg shadow-sky-500/10'
                    : 'border-white/5 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[10px] font-mono font-bold text-sky-400 uppercase tracking-wider">
                      {emp.employeeId}
                    </span>
                    <h3 className="text-base font-bold text-white group-hover:text-sky-300 transition">
                      {emp.displayName}
                    </h3>
                    <p className="text-xs text-slate-400">{emp.designation || 'Role not set'}</p>
                  </div>

                  <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    isOnline
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : isEnrolled
                      ? 'bg-slate-700 text-slate-300'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}>
                    {emp.accountStatus === 'PENDING_ACTIVATION'
                      ? 'INVITATION PENDING'
                      : emp.connectionStatus || emp.currentAgentStatus}
                  </span>
                </div>

                <div className="mt-4 pt-3 border-t border-white/5 space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Department:</span>
                    <span className="font-semibold text-slate-200">{emp.department || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Location:</span>
                    <span className="text-slate-300">{emp.workLocation || 'Not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Shift Schedule:</span>
                    <span className="font-mono text-slate-300">{emp.shiftStart && emp.shiftEnd ? <>{emp.shiftStart} &ndash; {emp.shiftEnd}</> : 'Schedule not set'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Assigned Devices:</span>
                    <span className="font-mono font-bold text-sky-400">{emp.deviceCount} registered</span>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-[11px]">
                  <span className="text-slate-500 flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${emp.monitoringAuthorized && emp.monitoringConsentGranted ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    {emp.monitoringAuthorized && emp.monitoringConsentGranted ? 'Authorized & Consented' : emp.monitoringAuthorized ? 'Awaiting Employee Consent' : 'Admin Authorization Required'}
                  </span>
                  <span className="text-sky-400 font-semibold group-hover:translate-x-0.5 transition-transform inline-block">
                    View Profile &rarr;
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <section className="mt-8 rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-white">Invitations</h2><span className="text-xs text-slate-500">{invitations.length} total</span></div>
        {invitations.length === 0 ? <p className="text-sm text-slate-500">No invitations yet. Invite an employee to begin onboarding.</p> : (
          <div className="divide-y divide-white/5">{invitations.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div><p className="text-slate-200">{invite.displayName || invite.email}</p><p className="text-xs text-slate-500">{invite.email} · expires {new Date(invite.expiresAt).toLocaleString()}</p></div>
              <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-white/5 px-2.5 py-1 text-xs capitalize text-slate-300">{invite.status === 'pending' ? 'Pending Acceptance' : invite.status}</span>
                {['pending', 'expired'].includes(invite.status) && <button disabled={busy} onClick={() => handleInvitationAction('resend', invite.id)} className="text-xs text-sky-300 disabled:opacity-50">Resend Invitation</button>}
                {invite.status === 'pending' && <><button disabled={busy} onClick={() => handleCopyInvitationLink(invitationLinks[invite.id])} className="text-xs text-emerald-300 disabled:opacity-50">Copy Invitation Link</button><button disabled={busy} onClick={() => handleInvitationAction('revoke', invite.id)} className="text-xs text-rose-300 disabled:opacity-50">Revoke Invitation</button></>}
              </div>
            </div>
          ))}</div>
        )}
      </section>

      {copyToast && <div role="status" aria-live="polite" className="fixed bottom-5 right-5 z-[80] rounded-lg border border-white/10 bg-slate-800 px-4 py-3 text-sm text-white shadow-xl">{copyToast}</div>}

      {showInviteModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4">
          {!inviteSuccess ? <form onSubmit={handleInviteEmployee} className="w-full max-w-lg space-y-4 rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between"><div><h2 className="text-lg font-bold text-white">Invite employee</h2><p className="mt-1 text-xs text-slate-400">They set their password when they accept. The link expires in seven days.</p></div><button type="button" onClick={() => { setShowInviteModal(false); setInviteCreated(false); setInviteLink(''); setInviteError(''); }} className="text-slate-400 hover:text-white">×</button></div>
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Employee name" required className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="employee@company.com" required className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
            <div className="grid grid-cols-2 gap-3"><input value={inviteDepartment} onChange={(e) => setInviteDepartment(e.target.value)} placeholder="Department" required className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /><select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"><option value="EMPLOYEE">Employee</option></select></div>
            <div className="grid grid-cols-2 gap-3"><label className="text-xs text-slate-400">Starts<input type="time" value={newShiftStart} onChange={(e) => setNewShiftStart(e.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label><label className="text-xs text-slate-400">Ends<input type="time" value={newShiftEnd} onChange={(e) => setNewShiftEnd(e.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label></div>
            {inviteError && <p role="status" className="text-sm text-amber-200">{inviteError}</p>}
            {inviteLink && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100"><p className="mb-2">Copy this one-time invitation link:</p><code className="break-all">{inviteLink}</code><button type="button" onClick={() => handleCopyInvitationLink(inviteLink)} className="ml-3 text-emerald-300 underline">Copy</button></div>}
            <Button type="submit" disabled={busy || inviteCreated} className="w-full bg-emerald-600 text-white">{inviteCreated ? 'Invitation created' : busy ? 'Creating…' : 'Create Invitation'}</Button>
          </form> : (
            <div role="dialog" aria-modal="true" aria-labelledby="invite-success-title" className="w-full max-w-lg space-y-4 rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
              <div className="flex items-start justify-between"><div><h2 id="invite-success-title" className="text-lg font-bold text-white">Invitation created successfully</h2><p className="mt-1 text-xs text-slate-400">They set their password when they accept.</p></div><button type="button" aria-label="Close invitation dialog" onClick={() => setShowInviteModal(false)} className="text-slate-400 hover:text-white">×</button></div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100"><p className="font-semibold">{inviteSuccess.invitation.displayName || inviteName}</p><p>{inviteSuccess.invitation.email || inviteEmail}</p><p className="mt-3 text-xs">Expires {new Date(inviteSuccess.expiresAt).toLocaleString()} · Pending Acceptance</p></div>
              {inviteSuccess.emailSent ? <p role="status" className="text-sm text-emerald-200">The invitation was saved and the email was sent.</p> : <p role="status" className="text-sm text-amber-200">The invitation is saved and remains active, but email delivery is unavailable. Copy and send this link to the employee.</p>}
              <div className="space-y-2 rounded-lg border border-white/10 bg-slate-950 p-3"><p className="text-xs font-semibold text-slate-300">Secure invitation link</p><code className="block break-all text-xs text-slate-200">{inviteSuccess.invitationUrl}</code><button type="button" onClick={() => handleCopyInvitationLink(inviteSuccess.invitationUrl)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white">Copy Invitation Link</button></div>
              <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} onClick={() => retryInvitationEmail(inviteSuccess.invitation.id)} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 disabled:opacity-50">{busy ? 'Retrying…' : inviteSuccess.emailSent ? 'Resend Email (new link)' : 'Retry Email (refresh link)'}</button><button type="button" onClick={() => setShowInviteModal(false)} className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-white">Done</button></div>
            </div>
          )}
        </div>
      )}

      {/* EMPLOYEE DETAIL PROFILE MODAL / DRAWER */}
      {selectedEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="rounded-2xl border border-white/10 bg-slate-900 p-6 max-w-2xl w-full shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-white/10 pb-4">
              <div>
                <span className="text-xs font-mono font-bold text-sky-400 uppercase">
                  {selectedEmployee.employeeId} &bull; {selectedEmployee.department}
                </span>
                <h2 className="text-2xl font-bold text-white mt-1">
                  {selectedEmployee.displayName}
                </h2>
                <p className="text-xs text-slate-400">{selectedEmployee.companyEmail} &bull; {selectedEmployee.designation || 'Role not set'}</p>
              </div>

              <button
                onClick={() => setSelectedEmployee(null)}
                className="text-slate-400 hover:text-white text-base p-1"
              >
                ✕
              </button>
            </div>

            {(selectedEmployee.devices?.length || 0) === 0 && (
              <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
                <p className="text-sm leading-6 text-amber-100">No device connected yet. Send your employee the setup instructions to install the DigitalPulse agent.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={handleInviteEmployeeToSetup} className="border-amber-400/30 bg-amber-500/15 text-amber-100">{busy ? 'Sending reminder…' : 'Send setup reminder'}</Button>
                  <Button onClick={() => navigate('/employee-setup')} className="bg-surface-800 text-white">View Installation Guide</Button>
                </div>
                {setupReminder && <div className="mt-3 text-xs text-slate-300"><p role="status">{setupReminder.message}</p>{setupReminder.showGuide && <Link className="mt-2 inline-block text-sky-300 underline" to="/employee-setup">Open installation guide</Link>}{setupReminder.url && <div className="mt-1 flex flex-wrap items-center gap-2"><code className="break-all text-sky-300">{setupReminder.url}</code><button type="button" onClick={() => navigator.clipboard?.writeText(setupReminder.url)} className="text-sky-300 underline">Copy link</button></div>}</div>}
              </section>
            )}

            <section className="grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <div><span className="text-slate-500">Device status</span><p className="mt-1 font-semibold text-slate-200">{selectedEmployee.deviceStatus === 'CONNECTED' ? 'Connected' : selectedEmployee.deviceStatus === 'OFFLINE' ? 'Offline' : 'Not Connected'}</p></div>
              <div><span className="text-slate-500">Enrollment status</span><p className="mt-1 font-semibold text-slate-200">{selectedEmployee.enrollmentStatus === 'ENROLLED' ? 'Enrolled' : 'Pending'}</p></div>
              <div><span className="text-slate-500">Monitoring status</span><p className="mt-1 font-semibold text-slate-200">{selectedEmployee.monitoringStatus === 'ACTIVE' ? 'Active' : selectedEmployee.monitoringStatus === 'WAITING_FOR_EVENTS' ? 'Waiting for events' : 'Not Started'}</p></div>
              <div><span className="text-slate-500">Last heartbeat</span><p className="mt-1 font-semibold text-slate-200">{selectedEmployee.lastHeartbeatAt ? new Date(selectedEmployee.lastHeartbeatAt).toLocaleString() : '—'}</p></div>
            </section>

            <section className="grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 text-xs sm:grid-cols-3">
              <div><span className="text-slate-500">Agent status</span><p className="mt-1 font-semibold text-slate-200">{agentDevice ? (agentDevice.status === 'online' ? 'Connected' : 'Offline') : 'Not Enrolled'}</p></div>
              <div><span className="text-slate-500">Extension status</span><p className="mt-1 font-semibold text-slate-200">{extensionDevice ? (extensionDevice.status === 'online' ? 'Connected' : 'Offline') : 'Not Enrolled'}</p></div>
              <div><span className="text-slate-500">Last successful sync</span><p className="mt-1 font-semibold text-slate-200">{selectedEmployee.lastSyncAt ? new Date(selectedEmployee.lastSyncAt).toLocaleString() : '—'}</p></div>
            </section>

            {/* Profile KPI Analytics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-slate-500">Monitored Today</span>
                <p className="text-xl font-bold font-mono text-white mt-0.5">{selectedEmployee.analytics?.totalMonitoredSeconds == null ? 'No data' : `${Math.floor(selectedEmployee.analytics.totalMonitoredSeconds / 3600)}h ${Math.floor((selectedEmployee.analytics.totalMonitoredSeconds % 3600) / 60)}m`}</p>
                <span className="text-[10px] text-slate-400">Monitored time</span>
              </div>

              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-slate-500">Active Focus</span>
                <p className="text-xl font-bold font-mono text-emerald-400 mt-0.5">{selectedEmployee.analytics?.activeSeconds == null ? 'No data' : `${Math.floor(selectedEmployee.analytics.activeSeconds / 3600)}h ${Math.floor((selectedEmployee.analytics.activeSeconds % 3600) / 60)}m`}</p>
                <span className="text-[10px] text-slate-400">Active time</span>
              </div>

              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-slate-500">Idle / Away</span>
                <p className="text-xl font-bold font-mono text-amber-400 mt-0.5">{selectedEmployee.analytics?.idleSeconds == null ? 'No data' : `${Math.floor(selectedEmployee.analytics.idleSeconds / 3600)}h ${Math.floor((selectedEmployee.analytics.idleSeconds % 3600) / 60)}m`}</p>
                <span className="text-[10px] text-slate-400">Idle time</span>
              </div>

              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-3">
                <span className="text-[10px] uppercase font-bold text-slate-500">Policy Violations</span>
                <p className="text-xl font-bold font-mono text-sky-400 mt-0.5">{selectedEmployee.analytics?.policyViolationsCount ?? '—'}</p>
                <span className="text-[10px] text-slate-400">Policy violations</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['App usage', selectedEmployee.analytics?.applicationUsage],
                ['Website usage', selectedEmployee.analytics?.websiteUsage],
              ].map(([title, entries]) => (
                <section key={title} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</h3>
                  {!selectedEmployee.analytics?.hasData || !entries?.length ? <p className="mt-3 text-sm text-slate-500">No data available</p> : (
                    <ul className="mt-3 space-y-2">{entries.slice(0, 8).map((entry) => <li key={entry.name} className="flex justify-between gap-3 text-xs"><span className="truncate text-slate-300">{entry.name}</span><span className="shrink-0 text-slate-400">{Math.floor(entry.seconds / 60)}m</span></li>)}</ul>
                  )}
                </section>
              ))}
            </div>

            {/* Shift & Organization Information */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-2 text-xs">
              <h4 className="font-semibold text-slate-200 uppercase tracking-wider text-[11px] mb-2">
                Employment & Shift Specifications
              </h4>
              <div className="grid grid-cols-2 gap-y-2 gap-x-4">
                <div>
                  <span className="text-slate-500">Working Shift:</span>
                  <p className="font-mono text-slate-200 font-medium">{selectedEmployee.shiftStart && selectedEmployee.shiftEnd ? `${selectedEmployee.shiftStart}–${selectedEmployee.shiftEnd} (${selectedEmployee.workingDays?.join(', ') || 'Working days not set'})` : 'Schedule not set'}</p>
                </div>
                <div>
                  <span className="text-slate-500">Work Location:</span>
                  <p className="text-slate-200 font-medium">{selectedEmployee.workLocation || 'Not set'}</p>
                </div>
                <div>
                  <span className="text-slate-500">Joining Date:</span>
                  <p className="font-mono text-slate-200">{selectedEmployee.joiningDate}</p>
                </div>
                <div>
                  <span className="text-slate-500">Employment Status:</span>
                  <p className="capitalize font-semibold text-emerald-400">{selectedEmployee.employmentStatus}</p>
                </div>
                <div>
                  <span className="text-slate-500">Monitoring Consent:</span>
                  <p className={`font-semibold ${selectedEmployee.monitoringConsentGranted ? 'text-emerald-300' : 'text-amber-200'}`}>{selectedEmployee.monitoringConsentGranted ? `Granted ${selectedEmployee.monitoringConsentAt ? `on ${new Date(selectedEmployee.monitoringConsentAt).toLocaleDateString()}` : ''}` : 'Not granted'}</p>
                </div>
                <div>
                  <span className="text-slate-500">Administrator Authorization:</span>
                  <p className={`font-semibold ${selectedEmployee.monitoringAuthorized ? 'text-emerald-300' : 'text-amber-200'}`}>{selectedEmployee.monitoringAuthorized ? 'Granted' : 'Not granted'}</p>
                </div>
              </div>
              {canAuthorizeMonitoring && <div className="flex flex-wrap items-center gap-3 border-t border-white/5 pt-3">
                <Button disabled={busy} onClick={() => handleMonitoringAuthorization(!selectedEmployee.monitoringAuthorized)}>
                  {busy ? 'Saving…' : selectedEmployee.monitoringAuthorized ? 'Revoke monitoring authorization' : 'Authorize monitoring'}
                </Button>
                <p className="text-xs text-slate-400">{authorizationMessage || 'Employee consent is still required before collection starts.'}</p>
              </div>}
            </div>

            {/* Assigned Endpoint Devices */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <h4 className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                  Assigned Hardware Endpoints ({selectedEmployee.devices?.length || 0})
                </h4>
              </div>

              {selectedEmployee.devices?.length === 0 ? (
                <p className="text-slate-500 italic">No Windows devices currently assigned to this employee.</p>
              ) : (
                <div className="space-y-2">
                  {selectedEmployee.devices.map((d) => (
                    <div key={d.id} className="flex items-center justify-between p-2.5 rounded-lg bg-surface-900 border border-white/5">
                      <div className="flex items-center gap-2.5">
                        <DeviceIcon width={16} height={16} className="text-sky-400" />
                        <div>
                          <p className="font-semibold text-slate-200">{d.name || d.id}</p>
                          <span className="text-[10px] text-slate-400 font-mono">{d.platform} &bull; {d.kind}</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-emerald-400">
                        {d.lastSeenAt ? `Seen ${new Date(d.lastSeenAt).toLocaleTimeString()}` : 'Enrolled'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {false && showInviteModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
                  <form onSubmit={handleInviteEmployee} className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
                    <div className="flex items-start justify-between">
                      <div>
                        <h2 className="text-lg font-bold text-white">Invite employee</h2>
                        <p className="mt-1 text-xs text-slate-400">The employee creates their password from the invitation.</p>
                      </div>
                      <button type="button" onClick={() => { setShowInviteModal(false); setInviteToken(''); }} className="text-slate-400 hover:text-white">✕</button>
                    </div>
                    <input
                      type="email"
                      required
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="employee@company.com"
                      className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                    />
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white">
                      <option value="EMPLOYEE">Employee</option>
                    </select>
                    <Button type="submit" disabled={busy} className="w-full bg-emerald-600 text-white">
                      {busy ? 'Sending…' : 'Send invitation'}
                    </Button>
                    {inviteLink && (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                        Invitation link: <span className="break-all font-mono">{inviteLink}</span>
                      </div>
                    )}
                  </form>
                </div>
              )}

              {/* Assign Device Select */}
              {allDevices.length > 0 && (
                <div className="pt-2 flex items-center gap-2">
                  <select
                    id="device-assign-select"
                    className="flex-1 rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-200"
                    defaultValue=""
                  >
                    <option value="" disabled>Select device to assign...</option>
                    {allDevices.filter((d) => !d.isRevoked && (!d.userId || d.userId === selectedEmployee.id) && !selectedEmployee.assignedDeviceIds?.includes(d.id)).map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.id.slice(0, 8)}...)</option>
                    ))}
                  </select>
                  <Button
                    onClick={() => {
                      const sel = document.getElementById('device-assign-select');
                      if (sel?.value) handleAssignDevice(selectedEmployee.id, sel.value);
                    }}
                    className="text-xs"
                    disabled={busy}
                  >
                    Assign Device
                  </Button>
                </div>
              )}
            </div>

            {/* Actions footer */}
            <div className="flex items-center justify-between pt-4 border-t border-white/10">
              <button
                onClick={() => handleDeleteEmployee(selectedEmployee.id)}
                className="text-xs text-rose-400 hover:text-rose-300 font-medium"
              >
                Deactivate employee
              </button>

              <Button onClick={() => setSelectedEmployee(null)} className="text-xs">
                Close Profile
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ADD EMPLOYEE MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="rounded-2xl border border-white/10 bg-slate-900 p-6 max-w-lg w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <h3 className="text-base font-bold text-white">Enroll New Employee</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white text-sm">✕</button>
            </div>

            <form onSubmit={handleCreateEmployee} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">First Name *</label>
                  <input
                    type="text"
                    required
                    value={newFirstName}
                    onChange={(e) => setNewFirstName(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100"
                    placeholder="e.g. John"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Last Name *</label>
                  <input
                    type="text"
                    required
                    value={newLastName}
                    onChange={(e) => setNewLastName(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100"
                    placeholder="e.g. Doe"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Employee ID</label>
                  <input
                    type="text"
                    value={newEmpId}
                    onChange={(e) => setNewEmpId(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 font-mono"
                    placeholder="Auto-generated if blank"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Company Email *</label>
                  <input
                    type="email"
                    required
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100"
                    placeholder="john.doe@enterprise.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Department</label>
                  <select
                    value={newDept}
                    onChange={(e) => setNewDept(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-200"
                  >
                    <option value="Engineering">Engineering</option>
                    <option value="Product Design">Product Design</option>
                    <option value="DevOps & Infrastructure">DevOps & Infrastructure</option>
                    <option value="Marketing">Marketing</option>
                    <option value="Sales">Sales</option>
                    <option value="Operations">Operations</option>
                    <option value="Support">Support</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Designation</label>
                  <input
                    type="text"
                    value={newDesignation}
                    onChange={(e) => setNewDesignation(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100"
                    placeholder="e.g. Backend Engineer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Shift Start</label>
                  <input
                    type="time"
                    value={newShiftStart}
                    onChange={(e) => setNewShiftStart(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Shift End</label>
                  <input
                    type="time"
                    value={newShiftEnd}
                    onChange={(e) => setNewShiftEnd(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-xs text-slate-100 font-mono"
                  />
                </div>
              </div>

              {inviteError && <p role="status" className="text-amber-200">{inviteError}</p>}
              {newEmployeeLink && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100"><p className="mb-2">Secure one-time onboarding link</p><code className="break-all">{newEmployeeLink}</code><button type="button" onClick={() => navigator.clipboard?.writeText(newEmployeeLink)} className="ml-3 underline">Copy</button></div>}
              <div className="pt-3 flex justify-end gap-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => { setShowAddModal(false); setNewEmployeeLink(''); setNewEmployeeCreated(false); setInviteError(''); }}
                  className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <Button type="submit" disabled={busy || newEmployeeCreated}>
                  {newEmployeeCreated ? 'Invitation created' : busy ? 'Creating…' : 'Start employee onboarding'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
