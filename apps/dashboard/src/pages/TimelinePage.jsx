import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function TimelinePage() {
  return (
    <>
      <PageHeader
        title="Activity Timeline"
        description="Chronological application, website and idle sessions."
      />
      <Card>
        <EmptyState title="No timeline entries yet">
          Timeline entries appear when the desktop agent or browser extension sends activity to
          the local backend. Start the agent to begin recording.
        </EmptyState>
      </Card>
    </>
  );
}

