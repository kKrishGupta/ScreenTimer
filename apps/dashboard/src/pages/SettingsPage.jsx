import { Card, PageHeader } from '../components/ui/Card.jsx';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1 (proxied to http://127.0.0.1:3001)';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Local dashboard configuration." />
      <Card title="Connection">
        <dl className="grid gap-3 text-sm">
          <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
            <dt className="text-slate-400">Backend API</dt>
            <dd className="font-mono text-slate-200">{API_BASE}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
            <dt className="text-slate-400">Deployment</dt>
            <dd className="text-slate-200">Localhost only</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}

