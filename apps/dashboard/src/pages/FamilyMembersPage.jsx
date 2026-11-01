import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function FamilyMembersPage() {
  return (
    <>
      <PageHeader
        title="Family Members"
        description="Profiles, authorized devices, and role assignments."
      />
      <Card>
        <EmptyState title="No family members configured">
          Configure family profiles to associate activity sessions, daily screen-time limits,
          and time goals with individual users.
        </EmptyState>
      </Card>
    </>
  );
}
