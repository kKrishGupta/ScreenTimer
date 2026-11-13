import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import Layout from './components/layout/Layout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import AcceptInvitationPage from './pages/AcceptInvitationPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';

const RoleHomePage = lazy(() => import('./pages/RoleHomePage.jsx'));
const EmployeesPage = lazy(() => import('./pages/EmployeesPage.jsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.jsx'));
const TimelinePage = lazy(() => import('./pages/TimelinePage.jsx'));
const DigitalWellbeingPage = lazy(() => import('./pages/DigitalWellbeingPage.jsx'));
const EmployeeWellbeingPage = lazy(() => import('./pages/EmployeeWellbeingPage.jsx'));
const ApplicationsPage = lazy(() => import('./pages/ApplicationsPage.jsx'));
const WebsitesPage = lazy(() => import('./pages/WebsitesPage.jsx'));
const ScreenMonitoringPage = lazy(() => import('./pages/ScreenMonitoringPage.jsx'));
const SchedulePage = lazy(() => import('./pages/SchedulePage.jsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'));
const FamilyPoliciesPage = lazy(() => import('./pages/FamilyPoliciesPage.jsx'));
const AlertsPage = lazy(() => import('./pages/AlertsPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));
const BlockedPage = lazy(() => import('./pages/BlockedPage.jsx'));
const DeclarativeRulesPage = lazy(() => import('./pages/DeclarativeRulesPage.jsx'));
const EmployeePortalPage = lazy(() => import('./pages/EmployeePortalPage.jsx'));
const EmployeeSetupPage = lazy(() => import('./pages/EmployeeSetupPage.jsx'));
const LiveMonitoringPage = lazy(() => import('./pages/LiveMonitoringPage.jsx'));
const BlockedActivityPage = lazy(() => import('./pages/BlockedActivityPage.jsx'));

function AuthLoading() {
  return <main className="grid min-h-screen place-items-center bg-surface-950 text-sm text-slate-400">Loading your secure workspace…</main>;
}

function PublicOnly({ children }) {
  const { loading, isAuthenticated, user } = useAuth();
  const location = useLocation();
  if (loading) return <AuthLoading />;
  if (!isAuthenticated) return children;
  const returnPath = location.state?.from?.pathname;
  if (location.pathname === '/login' && ['/accept-invitation', '/invitations/accept'].includes(returnPath)) return children;
  const destination = user?.role === 'EMPLOYEE'
    ? '/employee-portal'
    : user?.role === 'ADMIN'
      ? '/organization/'
      : '/';
  return <Navigate replace to={destination} />;
}

function AdminOnly({ children }) {
  const { loading, isAuthenticated, user } = useAuth();
  if (loading) return <AuthLoading />;
  if (!isAuthenticated) return <Navigate replace to="/login" />;
  if (user?.role === 'EMPLOYEE') return <Navigate replace to="/employee-portal" />;
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user?.role)) return <Navigate replace to="/login" />;
  return children;
}

function DigitalWellbeingRoute() {
  const { user } = useAuth();
  return user?.role === 'EMPLOYEE' ? <DigitalWellbeingPage personal /> : <ReportsPage />;
}

function ProtectedRoutes() {
  const { loading, isAuthenticated, logoutDestination } = useAuth();
  const location = useLocation();
  if (loading) return <AuthLoading />;
  if (!isAuthenticated) {
    return (
      <Navigate
        replace
        to={logoutDestination || '/login'}
        state={logoutDestination ? undefined : { from: location }}
      />
    );
  }
  return <Layout />;
}

function OrganizationRoutes() {
  return (
    <AdminOnly>
      <Outlet />
    </AdminOnly>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<AuthLoading />}><Routes>
        <Route path="login" element={<PublicOnly><LoginPage mode="employee" /></PublicOnly>} />
        <Route path="organization/login" element={<PublicOnly><LoginPage mode="admin" /></PublicOnly>} />
        <Route path="super-admin/login" element={<PublicOnly><LoginPage mode="super-admin" /></PublicOnly>} />
        <Route path="organization/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
        <Route path="forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
        {/* Capture and scrub reset credentials before the session lookup finishes. */}
        <Route path="reset-password" element={<ResetPasswordPage />} />
        {/* Invitation acceptance must remain reachable even when an administrator
            is signed in, because invitation links are often opened on the same
            browser that created them. */}
        <Route path="accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="invitations/accept" element={<AcceptInvitationPage />} />
      {/* Standalone Access Restricted Security Portal */}
        <Route path="blocked" element={<BlockedPage />} />

      <Route element={<ProtectedRoutes />}>
        <Route index element={<RoleHomePage />} />
        <Route path="organization" element={<OrganizationRoutes />}>
          <Route index element={<RoleHomePage />} />
          <Route path="employees" element={<EmployeesPage />} />
          <Route path="employee-wellbeing" element={<EmployeeWellbeingPage />} />
          <Route path="employee-setup" element={<EmployeeSetupPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="screen-monitoring" element={<ScreenMonitoringPage />} />
          <Route path="live" element={<LiveMonitoringPage />} />
          <Route path="blocked-activity" element={<BlockedActivityPage />} />
          <Route path="time-planner" element={<SchedulePage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
        </Route>
        <Route path="live" element={<AdminOnly><LiveMonitoringPage /></AdminOnly>} />
        <Route path="employee-portal" element={<EmployeePortalPage />} />
        <Route path="employee-setup" element={<EmployeeSetupPage />} />
        <Route path="employees" element={<AdminOnly><EmployeesPage /></AdminOnly>} />
        <Route path="family-members" element={<AdminOnly><EmployeesPage /></AdminOnly>} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="timeline" element={<TimelinePage />} />
        <Route path="applications" element={<AdminOnly><ApplicationsPage /></AdminOnly>} />
        <Route path="websites" element={<AdminOnly><WebsitesPage /></AdminOnly>} />
        <Route path="blocked-activity" element={<AdminOnly><BlockedActivityPage /></AdminOnly>} />
        <Route path="screen-monitoring" element={<AdminOnly><ScreenMonitoringPage /></AdminOnly>} />
        <Route path="time-planner" element={<AdminOnly><SchedulePage /></AdminOnly>} />
        <Route path="schedule" element={<AdminOnly><SchedulePage /></AdminOnly>} />
        <Route path="reports" element={<AdminOnly><ReportsPage /></AdminOnly>} />
        <Route path="digital-wellbeing" element={<DigitalWellbeingRoute />} />
        <Route path="policies" element={<AdminOnly><FamilyPoliciesPage /></AdminOnly>} />
        <Route path="family-policies" element={<AdminOnly><FamilyPoliciesPage /></AdminOnly>} />
        <Route path="policies/declarative-rules" element={<AdminOnly><DeclarativeRulesPage /></AdminOnly>} />
        <Route path="declarative-rules" element={<AdminOnly><DeclarativeRulesPage /></AdminOnly>} />
        <Route path="alerts" element={<AdminOnly><AlertsPage /></AdminOnly>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      </Routes></Suspense>
    </AuthProvider>
  );
}
