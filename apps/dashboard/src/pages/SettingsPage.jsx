import { Card, PageHeader } from '../components/ui/Card.jsx';
import { API_BASE } from '../lib/api.js';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="DigitalPulse connection settings." />
      <Card title="Connection">
        <dl className="grid gap-3 text-sm">
          <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
            <dt className="text-slate-400">Backend API</dt>
            <dd className="font-mono text-slate-200">{API_BASE}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
            <dt className="text-slate-400">Deployment</dt>
            <dd className="text-slate-200">{import.meta.env.DEV ? 'Development' : 'Production'}</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}

