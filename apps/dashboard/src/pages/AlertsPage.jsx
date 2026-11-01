import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function AlertsPage() {
  return (
    <>
      <PageHeader
        title="Alerts & Notifications"
        description="System health notices, policy warnings, and productivity milestones."
      />
      <Card>
        <EmptyState title="No active notifications">
          All systems are running normally. Policy exceedances, collector status changes,
          and system notices will appear in this log.
        </EmptyState>
      </Card>
    </>
  );
}
