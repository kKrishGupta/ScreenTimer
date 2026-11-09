import { useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button, Card } from '../ui/Card.jsx';
import { EmptyState } from '../ui/States.jsx';

const FILTERS = ['ALL', 'ACTIVE', 'OFFLINE', 'PENDING', 'REVOKED', 'ARCHIVED'];
const fmt = (value) => value ? new Date(value).toLocaleString() : 'Never';
const collector = (device) => String(device.kind || device.deviceKind || '').toUpperCase() === 'DESKTOP_AGENT'
  ? 'Windows Desktop Agent'
  : `Browser Extension${device.browser ? ` (${device.browser})` : ''}`;

function statusClass(status) {
  return status === 'ACTIVE' || status === 'ONLINE' || status === 'AUTHORIZED'
    ? 'bg-emerald-500/10 text-emerald-300'
    : status === 'REVOKED'
      ? 'bg-rose-500/10 text-rose-300'
      : status === 'ARCHIVED'
        ? 'bg-violet-500/10 text-violet-300'
        : 'bg-slate-500/10 text-slate-300';
}

export default function DeviceLifecycleManager({ devices, pendingEnrollments = [], reload, announce }) {
  const [filter, setFilter] = useState('ALL');
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(null);
  const [audit, setAudit] = useState([]);
  const [review, setReview] = useState(null);

  const rows = useMemo(() => [
    ...devices,
    ...pendingEnrollments.map((token) => ({ ...token, pendingToken: true, name: 'Enrollment pending' })),
  ], [devices, pendingEnrollments]);
  const visible = rows.filter((device) => {
    if (filter === 'ALL') return true;
    if (filter === 'PENDING') return device.lifecycleStatus === 'PENDING';
    if (filter === 'OFFLINE') return device.lifecycleStatus === 'ACTIVE' && device.connectionStatus !== 'ONLINE';
    return device.lifecycleStatus === filter;
  });

  const toggle = (id) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const openDetails = async (device) => {
    setBusy(true);
    try {
      const [record, history] = await Promise.all([api.deviceDetails(device.id), api.deviceAudit(device.id)]);
      setDetails(record.device);
      setAudit(history.events || []);
    } catch (error) { announce(error.message || 'Device details could not be loaded.'); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    setBusy(true);
    try {
      if (dialog.bulk) {
        const result = await api.bulkDeviceAction(dialog.action, selected, reason);
        const succeeded = result.results.filter((item) => item.success).length;
        announce(`${succeeded} of ${result.results.length} devices ${dialog.action === 'revoke' ? 'revoked' : 'archived'}.`);
        setSelected(result.results.filter((item) => !item.success).map((item) => item.deviceId));
      } else if (dialog.action === 'revoke') await api.revokeDevice(dialog.device.id, reason);
      else if (dialog.action === 'archive') await api.archiveDevice(dialog.device.id, reason);
      else if (dialog.action === 'restore') await api.restoreDevice(dialog.device.id);
      else if (dialog.action === 'revoke-token') await api.revokeEnrollmentToken(dialog.device.id);
      else if (dialog.action === 'authorize') await api.updateScreenDevice(dialog.device.id, dialog.enabled);
      if (!dialog.bulk) announce(dialog.action === 'revoke-token' ? 'Enrollment token revoked successfully.' : `Device ${dialog.action} completed successfully.`);
      setDialog(null); setReason(''); await reload();
    } catch (error) { announce(error.message || 'The device action failed.'); }
    finally { setBusy(false); }
  };
  const duplicateReview = async () => {
    setBusy(true);
    try { setReview((await api.duplicateDeviceReview()).candidates || []); }
    catch (error) { announce(error.message || 'Duplicate review could not be loaded.'); }
    finally { setBusy(false); }
  };

  return <Card title="Device lifecycle management" action={<Button disabled={busy} onClick={duplicateReview}>Review possible duplicates</Button>}>
    <p className="mb-4 text-xs leading-5 text-slate-400">Lifecycle, connection, and screenshot authorization are independent. Potential duplicates are review-only and are never merged automatically.</p>
    <div className="mb-4 flex flex-wrap gap-2" aria-label="Device filters">{FILTERS.map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg border px-3 py-1.5 text-xs ${filter === value ? 'border-sky-400/50 bg-sky-400/10 text-sky-200' : 'border-white/10 text-slate-400'}`}>{value === 'ALL' ? 'All devices' : value[0] + value.slice(1).toLowerCase()}</button>)}</div>
    {selected.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3"><span className="text-xs text-slate-300">{selected.length} selected</span><Button onClick={() => setDialog({ action: 'archive', bulk: true })}>Archive selected</Button><Button className="text-rose-200" onClick={() => setDialog({ action: 'revoke', bulk: true })}>Revoke selected</Button><Button onClick={() => setSelected([])}>Clear</Button></div>}
    {visible.length === 0 ? <EmptyState title="No devices in this view">Choose another lifecycle filter or enroll a device.</EmptyState> : <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-xs"><thead className="border-b border-white/10 text-slate-500"><tr><th className="p-2">Select</th><th className="p-2">Employee / device</th><th className="p-2">Collector</th><th className="p-2">Enrollment / heartbeat</th><th className="p-2">Connection</th><th className="p-2">Lifecycle</th><th className="p-2">Screenshot authorization</th><th className="p-2">Verified screenshot / sync</th><th className="p-2">Actions</th></tr></thead><tbody>{visible.map((device) => <tr key={`${device.pendingToken ? 'token' : 'device'}-${device.id}`} className="border-b border-white/5 align-top">
      <td className="p-2">{!device.pendingToken && <input aria-label={`Select ${device.name}`} type="checkbox" checked={selected.includes(device.id)} onChange={() => toggle(device.id)} />}</td>
      <td className="p-2"><p className="font-medium text-slate-100">{device.assignedUser?.displayName || 'Unassigned'}</p><p className="text-slate-500">{device.assignedUser?.email || 'No employee email'}</p><p className="mt-1 text-slate-300">{device.name}</p></td>
      <td className="p-2 text-slate-300">{collector(device)}<p className="text-slate-500">{device.platform || 'Awaiting enrollment'}</p></td>
      <td className="p-2 text-slate-300">{fmt(device.createdAt)}<p className="text-slate-500">Heartbeat: {fmt(device.lastSeenAt)}</p></td>
      <td className="p-2"><span className={`rounded px-2 py-1 ${statusClass(device.connectionStatus)}`}>{device.connectionStatus || 'UNKNOWN'}</span></td>
      <td className="p-2"><span className={`rounded px-2 py-1 ${statusClass(device.lifecycleStatus)}`}>{device.lifecycleStatus}</span>{(device.revocationReason || device.archiveReason) && <p className="mt-2 max-w-40 text-slate-500">{device.revocationReason || device.archiveReason}</p>}</td>
      <td className="p-2"><span className={`rounded px-2 py-1 ${statusClass(device.authorizationStatus)}`}>{device.authorizationStatus || 'UNAUTHORIZED'}</span></td>
      <td className="p-2 text-slate-300">{fmt(device.lastVerifiedScreenshotAt)}<p className="text-slate-500">{device.lastSynchronizationStatus || 'NEVER_SYNCED'}</p></td>
      <td className="p-2"><div className="flex max-w-56 flex-wrap gap-1">{!device.pendingToken && <Button disabled={busy} onClick={() => openDetails(device)}>Details / audit</Button>}{device.pendingToken && <Button className="text-rose-200" onClick={() => setDialog({ action: 'revoke-token', device })}>Revoke token</Button>}{device.lifecycleStatus === 'ACTIVE' && <><Button onClick={() => setDialog({ action: 'authorize', device, enabled: !device.screenCaptureEnabled })}>{device.screenCaptureEnabled ? 'Unauthorize' : 'Authorize'}</Button><Button onClick={() => setDialog({ action: 'archive', device })}>Archive</Button><Button className="text-rose-200" onClick={() => setDialog({ action: 'revoke', device })}>Revoke</Button></>}{device.lifecycleStatus === 'ARCHIVED' && <Button onClick={() => setDialog({ action: 'restore', device })}>Restore</Button>}</div></td>
    </tr>)}</tbody></table></div>}

    {dialog && <div role="dialog" aria-modal="true" aria-labelledby="device-action-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-lg rounded-xl border border-white/10 bg-slate-900 p-5"><h3 id="device-action-title" className="font-semibold text-white">Confirm {dialog.action}</h3><p className="mt-2 text-sm text-slate-300">{dialog.action === 'revoke' ? 'Revocation is permanent. Selected devices will lose access to heartbeat, activity synchronization, screenshots, and monitoring uploads.' : dialog.action === 'revoke-token' ? 'This one-time enrollment token will no longer be accepted. Existing enrolled devices and their credentials are unchanged.' : dialog.action === 'archive' ? 'Archived devices stop operating but retain their historical activity, screenshots, and audit references.' : dialog.action === 'authorize' ? 'This changes device selection only. Consent, schedules, account state, and organization policy still apply.' : 'Restoring an archived device preserves its existing credential; revoked credentials can never be restored.'}</p>{['revoke', 'archive'].includes(dialog.action) && <label className="mt-4 block text-xs text-slate-400">Reason (optional)<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} className="mt-1 min-h-20 w-full rounded-lg border border-white/10 bg-slate-950 p-2 text-sm text-white" /></label>}<div className="mt-4 flex justify-end gap-2"><Button disabled={busy} onClick={() => { setDialog(null); setReason(''); }}>Cancel</Button><Button disabled={busy} className={['revoke', 'revoke-token'].includes(dialog.action) ? 'text-rose-200' : ''} onClick={execute}>{busy ? 'Working…' : 'Confirm'}</Button></div></div></div>}
    {details && <div role="dialog" aria-modal="true" aria-labelledby="device-details-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-5"><div className="flex justify-between gap-3"><div><h3 id="device-details-title" className="font-semibold text-white">{details.name}</h3><p className="font-mono text-xs text-slate-500">{details.id}</p></div><Button onClick={() => { setDetails(null); setAudit([]); }}>Close</Button></div><dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">Lifecycle</dt><dd className="text-slate-200">{details.lifecycleStatus}</dd></div><div><dt className="text-slate-500">Connection</dt><dd className="text-slate-200">{details.connectionStatus}</dd></div><div><dt className="text-slate-500">Authorization</dt><dd className="text-slate-200">{details.authorizationStatus}</dd></div><div><dt className="text-slate-500">Last heartbeat</dt><dd className="text-slate-200">{fmt(details.lastSeenAt)}</dd></div></dl><h4 className="mt-6 text-sm font-semibold text-slate-200">Immutable audit history</h4>{audit.length === 0 ? <p className="mt-2 text-sm text-slate-500">No device audit events found.</p> : <ol className="mt-2 space-y-2">{audit.map((event) => <li key={event.id} className="rounded-lg border border-white/5 p-3 text-xs"><p className="font-medium text-slate-200">{event.action}</p><p className="text-slate-500">{fmt(event.timestamp)} · {event.actor}</p></li>)}</ol>}</div></div>}
    {review && <div role="dialog" aria-modal="true" aria-labelledby="duplicate-review-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-5"><div className="flex justify-between"><h3 id="duplicate-review-title" className="font-semibold text-white">Possible duplicate review</h3><Button onClick={() => setReview(null)}>Close</Button></div><p className="mt-2 text-sm text-slate-400">No records are merged or deleted automatically.</p>{review.length === 0 ? <p className="mt-4 text-sm text-emerald-300">No possible duplicate groups found.</p> : review.map((group, index) => <div key={index} className="mt-4 rounded-lg border border-white/10 p-3"><p className="text-xs text-amber-200">{group.reviewReason}</p>{group.devices.map((device) => <p key={device.id} className="mt-2 text-xs text-slate-300">{device.name} · {device.assignedUser?.email || 'unassigned'} · <span className="font-mono">{device.id}</span> · {device.lifecycleStatus}</p>)}</div>)}</div></div>}
  </Card>;
}
