import { useAuth } from '../context/AuthContext.jsx';
import { Navigate } from 'react-router';
import OverviewPage from './OverviewPage.jsx';
import EmployeePortalPage from './EmployeePortalPage.jsx';

export default function RoleHomePage() {
  const { user } = useAuth();

  if (user?.role === 'EMPLOYEE') {
    return <EmployeePortalPage />;
  }

  return <OverviewPage />;
}
