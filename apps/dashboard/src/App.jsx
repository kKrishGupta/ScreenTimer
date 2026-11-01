import { Route, Routes } from 'react-router';
import Layout from './components/layout/Layout.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import FamilyMembersPage from './pages/FamilyMembersPage.jsx';
import DevicesPage from './pages/DevicesPage.jsx';
import TimelinePage from './pages/TimelinePage.jsx';
import ApplicationsPage from './pages/ApplicationsPage.jsx';
import WebsitesPage from './pages/WebsitesPage.jsx';
import ScreenMonitoringPage from './pages/ScreenMonitoringPage.jsx';
import TimePlannerPage from './pages/TimePlannerPage.jsx';
import DigitalWellbeingPage from './pages/DigitalWellbeingPage.jsx';
import FamilyPoliciesPage from './pages/FamilyPoliciesPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="family-members" element={<FamilyMembersPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="timeline" element={<TimelinePage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="screen-monitoring" element={<ScreenMonitoringPage />} />
        <Route path="time-planner" element={<TimePlannerPage />} />
        <Route path="digital-wellbeing" element={<DigitalWellbeingPage />} />
        <Route path="family-policies" element={<FamilyPoliciesPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
