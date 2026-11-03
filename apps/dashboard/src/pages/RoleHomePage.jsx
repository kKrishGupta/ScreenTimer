import { useAuth } from '../context/AuthContext.jsx';
import OverviewPage from './OverviewPage.jsx';
import EmployeePortalPage from './EmployeePortalPage.jsx';

export default function RoleHomePage() {
  const { user } = useAuth();
  return user?.role === 'EMPLOYEE' ? <EmployeePortalPage /> : <OverviewPage />;
}
