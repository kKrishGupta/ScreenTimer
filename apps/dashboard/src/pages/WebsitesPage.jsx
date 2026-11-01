import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function WebsitesPage() {
  return (
    <>
      <PageHeader
        title="Website Usage"
        description="Active time and visits per website domain (Chrome and Edge)."
      />
      <Card>
        <EmptyState title="No website usage recorded">
          Install the DigitalPulse extension in Chrome or Edge. Only domain names are tracked.
          Page content, search queries and form data are never collected.
        </EmptyState>
      </Card>
    </>
  );
}

