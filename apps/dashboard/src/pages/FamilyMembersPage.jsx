import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { UsersIcon } from '../components/ui/icons.jsx';

export default function FamilyMembersPage() {
  const fetchMembers = useCallback((opts) => api.familyMembers(opts), []);
  const fetchDevices = useCallback((opts) => api.devices(opts), []);

  const { data: membersData, error: membersErr, loading: membersLoading, reload: reloadMembers } = useApi(fetchMembers, { intervalMs: 180_000, staleTimeMs: 120_000 });
  const { data: devicesData } = useApi(fetchDevices);

  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('member');
  const [newAge, setNewAge] = useState('adult');
  const [busy, setBusy] = useState(false);
  const [selectedDeviceByMember, setSelectedDeviceByMember] = useState({});

  const members = membersData?.members ?? [];
  const availableDevices = devicesData?.devices ?? [];

  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      setBusy(true);
      await api.createFamilyMember({
        displayName: newName.trim(),
        role: newRole,
        ageBracket: newAge,
        consentGranted: true,
      });
      setNewName('');
      reloadMembers();
    } catch (err) {
      alert(`Error creating member: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAssignDevice = async (memberId) => {
    const devId = selectedDeviceByMember[memberId];
    if (!devId) return;
    try {
      setBusy(true);
      await api.assignFamilyDevice(memberId, devId);
      reloadMembers();
    } catch (err) {
      alert(`Error assigning device: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteMember = async (id) => {
    if (!confirm('Are you sure you want to remove this family member profile?')) return;
    try {
      setBusy(true);
      await api.deleteFamilyMember(id);
      reloadMembers();
    } catch (err) {
      alert(`Error deleting member: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Family Members & Household"
          description="Manage household profiles, assign monitored devices, and verify consent status."
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3 my-6">
        {/* Add Member Form */}
        <Card title="Add Family Profile">
          <form onSubmit={handleAddMember} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Display Name</label>
              <input
                type="text"
                placeholder="e.g. Jordan (Child)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Family Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="owner">Family Owner</option>
                  <option value="parent">Parent</option>
                  <option value="child">Child</option>
                  <option value="member">Member</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Age Bracket</label>
                <select
                  value={newAge}
                  onChange={(e) => setNewAge(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs text-slate-200"
                >
                  <option value="adult">Adult (18+)</option>
                  <option value="teen">Teen (13-17)</option>
                  <option value="child">Child (&lt;13)</option>
                </select>
              </div>
            </div>

            <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 text-xs text-slate-400">
              <span className="font-semibold text-slate-200">Consent & Privacy: </span>
              Adults must provide affirmative consent; for children under 13, guardian authorization is registered.
            </div>

            <Button type="submit" disabled={busy || !newName.trim()} className="w-full">
              Add Family Member
            </Button>
          </form>
        </Card>

        {/* Member Cards List */}
        <div className="lg:col-span-2 space-y-4">
          <Card title={`Household Members (${members.length})`}>
            {membersLoading && !membersData && <LoadingState label="Loading family profiles…" />}
            {membersErr && <ErrorState error={membersErr} onRetry={reloadMembers} />}

            {!membersLoading && members.length === 0 && (
              <EmptyState title="No family members configured">
                Add family member profiles using the form on the left.
              </EmptyState>
            )}

            {members.length > 0 && (
              <div className="space-y-4">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-slate-100">{member.displayName}</h4>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          member.role === 'owner'
                            ? 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20'
                            : member.role === 'child'
                            ? 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20'
                            : 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/20'
                        }`}>
                          {member.role.toUpperCase()}
                        </span>
                        <span className="text-xs text-slate-500 font-mono">({member.ageBracket})</span>
                      </div>

                      <p className="text-xs text-slate-400">{member.email}</p>

                      <div className="flex items-center gap-3 pt-1 text-xs">
                        <span className="text-emerald-400 flex items-center gap-1">
                          ✓ Consent Authorized
                        </span>
                        <span className="text-slate-500">&bull;</span>
                        <span className="text-slate-400">
                          {member.assignedDeviceIds?.length ?? 0} assigned devices
                        </span>
                      </div>
                    </div>

                    {/* Device Assignment Control */}
                    <div className="flex items-center gap-2 border-t md:border-t-0 pt-3 md:pt-0 border-white/5">
                      {availableDevices.length > 0 && (
                        <>
                          <select
                            value={selectedDeviceByMember[member.id] || ''}
                            onChange={(e) => setSelectedDeviceByMember({ ...selectedDeviceByMember, [member.id]: e.target.value })}
                            className="rounded-lg border border-white/10 bg-surface-900 px-2 py-1 text-xs text-slate-200"
                          >
                            <option value="">Assign device…</option>
                            {availableDevices.map((d) => (
                              <option key={d.id} value={d.id}>{d.name} ({d.platform})</option>
                            ))}
                          </select>
                          <Button
                            onClick={() => handleAssignDevice(member.id)}
                            disabled={busy || !selectedDeviceByMember[member.id]}
                            className="text-xs"
                          >
                            Assign
                          </Button>
                        </>
                      )}

                      {member.role !== 'owner' && (
                        <button
                          onClick={() => handleDeleteMember(member.id)}
                          className="text-slate-500 hover:text-rose-400 text-xs px-2 py-1 transition"
                          title="Remove member"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
