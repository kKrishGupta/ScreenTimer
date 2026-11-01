import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function ApplicationsPage() {
  return (
    <>
      <PageHeader
        title="Application Usage"
        description="Active time, session count and usage distribution per application."
      />
      <Card>
        <EmptyState title="No application usage recorded">
          Start the DigitalPulse desktop agent. Each application you focus will appear here
          with its total active time.
        </EmptyState>
      </Card>
    </>
  );
}

