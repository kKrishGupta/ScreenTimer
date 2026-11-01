import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function DevicesPage() {
  return (
    <>
      <PageHeader
        title="Device Status"
        description="Desktop agent and browser extension connectivity."
      />
      <Card>
        <EmptyState title="No collectors have connected yet">
          Devices register automatically the first time the desktop agent or browser extension
          synchronises with the local backend.
        </EmptyState>
      </Card>
    </>
  );
}

