import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import Layout from './components/layout/Layout.jsx';
import RoleHomePage from './pages/RoleHomePage.jsx';
import EmployeesPage from './pages/EmployeesPage.jsx';
import DevicesPage from './pages/DevicesPage.jsx';
import TimelinePage from './pages/TimelinePage.jsx';
import ApplicationsPage from './pages/ApplicationsPage.jsx';
import WebsitesPage from './pages/WebsitesPage.jsx';
import ScreenMonitoringPage from './pages/ScreenMonitoringPage.jsx';
import SchedulePage from './pages/SchedulePage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import FamilyPoliciesPage from './pages/FamilyPoliciesPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import BlockedPage from './pages/BlockedPage.jsx';
import DeclarativeRulesPage from './pages/DeclarativeRulesPage.jsx';
import EmployeePortalPage from './pages/EmployeePortalPage.jsx';
import EmployeeSetupPage from './pages/EmployeeSetupPage.jsx';
import LiveMonitoringPage from './pages/LiveMonitoringPage.jsx';
import BlockedActivityPage from './pages/BlockedActivityPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import AcceptInvitationPage from './pages/AcceptInvitationPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';

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
  return <Navigate replace to={user?.role === 'EMPLOYEE' ? '/employee-portal' : '/'} />;
}

function AdminOnly({ children }) {
  const { loading, isAuthenticated, user } = useAuth();
  if (loading) return <AuthLoading />;
  if (!isAuthenticated) return <Navigate replace to="/login" />;
  if (user?.role === 'EMPLOYEE') return <Navigate replace to="/employee-portal" />;
  return children;
}

function ProtectedRoutes() {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();
  if (loading) return <AuthLoading />;
  if (!isAuthenticated) return <Navigate replace to="/login" state={{ from: location }} />;
  return <Layout />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="login" element={<PublicOnly><LoginPage /></PublicOnly>} />
        <Route path="register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
        <Route path="forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
        <Route path="reset-password" element={<PublicOnly><ResetPasswordPage /></PublicOnly>} />
        {/* Invitation acceptance must remain reachable even when an administrator
            is signed in, because invitation links are often opened on the same
            browser that created them. */}
        <Route path="accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="invitations/accept" element={<AcceptInvitationPage />} />
      {/* Standalone Access Restricted Security Portal */}
        <Route path="blocked" element={<BlockedPage />} />

      <Route element={<ProtectedRoutes />}>
        <Route index element={<RoleHomePage />} />
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
        <Route path="digital-wellbeing" element={<TimelinePage />} />
        <Route path="policies" element={<AdminOnly><FamilyPoliciesPage /></AdminOnly>} />
        <Route path="family-policies" element={<AdminOnly><FamilyPoliciesPage /></AdminOnly>} />
        <Route path="policies/declarative-rules" element={<AdminOnly><DeclarativeRulesPage /></AdminOnly>} />
        <Route path="declarative-rules" element={<AdminOnly><DeclarativeRulesPage /></AdminOnly>} />
        <Route path="alerts" element={<AdminOnly><AlertsPage /></AdminOnly>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      </Routes>
    </AuthProvider>
  );
}
