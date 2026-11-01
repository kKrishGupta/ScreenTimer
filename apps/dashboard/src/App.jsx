import { Route, Routes } from 'react-router';
import Layout from './components/layout/Layout.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import TimelinePage from './pages/TimelinePage.jsx';
import ApplicationsPage from './pages/ApplicationsPage.jsx';
import WebsitesPage from './pages/WebsitesPage.jsx';
import DevicesPage from './pages/DevicesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="timeline" element={<TimelinePage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

