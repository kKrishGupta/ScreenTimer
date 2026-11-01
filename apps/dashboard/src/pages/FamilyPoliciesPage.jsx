import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function FamilyPoliciesPage() {
  return (
    <>
      <PageHeader
        title="Family Policies"
        description="Allowed categories, domain restrictions, warnings, and local parental controls."
      />
      <Card>
        <EmptyState title="No restriction policies active">
          Set up allowed categories and restricted website domains. Warnings and compliance notifications
          will appear here when policy boundaries are reached.
        </EmptyState>
      </Card>
    </>
  );
}
