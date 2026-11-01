import { NavLink, Outlet } from 'react-router';
import BackendStatus from './BackendStatus.jsx';
import {
  AppIcon,
  DeviceIcon,
  GlobeIcon,
  GridIcon,
  PulseIcon,
  SettingsIcon,
  TimelineIcon,
} from '../ui/icons.jsx';

const NAV = [
  { to: '/', label: 'Overview', icon: GridIcon, end: true },
  { to: '/timeline', label: 'Activity Timeline', icon: TimelineIcon },
  { to: '/applications', label: 'Application Usage', icon: AppIcon },
  { to: '/websites', label: 'Website Usage', icon: GlobeIcon },
  { to: '/devices', label: 'Device Status', icon: DeviceIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function Layout() {
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-white/5 bg-surface-900/60 px-4 py-6 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500/15 text-accent-400">
            <PulseIcon />
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">DigitalPulse</span>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? 'bg-accent-500/10 text-accent-400'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-2 text-xs text-slate-500">Stage 1 · Local MVP</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-950/80 px-6 py-3 backdrop-blur">
          <span className="text-sm text-slate-400 md:hidden">DigitalPulse</span>
          <div className="ml-auto">
            <BackendStatus />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

