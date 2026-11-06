import { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router';
import BackendStatus from './BackendStatus.jsx';
import {
  AppIcon,
  BellIcon,
  CalendarIcon,
  DeviceIcon,
  GlobeIcon,
  GridIcon,
  HeartIcon,
  PulseIcon,
  ScreenIcon,
  SettingsIcon,
  ShieldIcon,
  TimelineIcon,
  UsersIcon,
} from '../ui/icons.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useNavigate } from 'react-router';

const NAV = [
  { to: '/', label: 'Overview', icon: GridIcon, end: true },
  { to: '/employees', label: 'Employees', icon: UsersIcon },
  { to: '/employee-setup', label: 'My Device', icon: DeviceIcon },
  { to: '/devices', label: 'Organization Devices', icon: ScreenIcon },
  { to: '/live', label: 'Activity', icon: PulseIcon },
  { to: '/blocked-activity', label: 'Website Blocking', icon: ShieldIcon },
  { to: '/time-planner', label: 'Schedule', icon: CalendarIcon },
  { to: '/reports', label: 'Reports', icon: TimelineIcon },
  { to: '/alerts', label: 'Alerts', icon: BellIcon },
];

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const session = user ? { user } : null;
  const isEmployee = user?.role === 'EMPLOYEE';
  const nav = isEmployee
    ? [
        { to: '/employee-portal', label: 'My Workspace', icon: GridIcon },
        { to: '/timeline', label: 'My Activity', icon: TimelineIcon },
        { to: '/devices', label: 'My Devices', icon: DeviceIcon },
        { to: '/digital-wellbeing', label: 'Digital Wellbeing', icon: HeartIcon },
        { to: '/settings', label: 'Privacy & Account', icon: SettingsIcon },
      ]
    : ['ADMIN', 'SUPER_ADMIN'].includes(user?.role) ? NAV : [];

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  // Close mobile drawer on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex min-h-full">
      {/* Desktop Persistent Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-white/5 bg-surface-900/60 px-4 py-6 md:flex overflow-y-auto">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500/15 text-accent-400">
            <PulseIcon />
          </span>
          <div>
            <span className="text-lg font-semibold tracking-tight text-white block leading-tight">DigitalPulse</span>
            <span className="text-[10px] tracking-wider uppercase font-semibold text-emerald-400">Local</span>
          </div>
        </div>

        <nav aria-label="Main" className="flex flex-col gap-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? 'bg-accent-500/10 text-accent-400 font-medium'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto pt-6 px-2 text-xs text-slate-500 font-mono">Enterprise &bull; Endpoint Intelligence</p>
      </aside>

      {/* Mobile Slide-Out Drawer & Backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label="Mobile Navigation Panel">
          {/* Backdrop overlay */}
          <div
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />

          {/* Slide-out Sidebar Menu */}
          <div className="relative flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-surface-900 px-4 py-6 shadow-2xl overflow-y-auto animate-in slide-in-from-left duration-200">
            <div className="mb-6 flex items-center justify-between px-2">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-500/15 text-accent-400">
                  <PulseIcon />
                </span>
                <div>
                  <span className="text-lg font-semibold tracking-tight text-white block leading-tight">DigitalPulse</span>
                  <span className="text-[10px] tracking-wider uppercase font-semibold text-emerald-400">Local</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white transition"
              >
                ✕
              </button>
            </div>

            <nav aria-label="Mobile Navigation" className="flex flex-col gap-1">
              {nav.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                      isActive
                        ? 'bg-accent-500/15 text-accent-400 font-semibold'
                        : 'text-slate-300 hover:bg-white/5 hover:text-white'
                    }`
                  }
                >
                  <Icon />
                  {label}
                </NavLink>
              ))}
            </nav>

            <p className="mt-auto pt-6 px-2 text-xs text-slate-500 font-mono">Enterprise &bull; Endpoint Intelligence</p>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/5 bg-surface-950/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-3 md:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open side panel navigation"
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 hover:text-white transition shadow-sm"
            >
              <svg className="w-4 h-4 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              <span>Menu</span>
            </button>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-white">DigitalPulse</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 uppercase font-bold">Local</span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {session?.user && (
              <>
               <span className="hidden rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-sky-300 sm:inline">
                 {isEmployee ? 'Employee Portal' : 'Admin Console'}
               </span>
               <div className="hidden text-right text-xs sm:block">
                 <p className="font-medium text-white">{user.displayName || user.email}</p>
                 <p className="text-slate-500">{user.email} · {user.role}</p>
                 <NavLink to="/settings" className="text-sky-400 hover:text-sky-300">Profile & account settings</NavLink>
               </div>
               <button onClick={handleLogout} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5">Logout</button>
              </>
            )}
            <BackendStatus />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
