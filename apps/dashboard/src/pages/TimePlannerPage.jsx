import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function TimePlannerPage() {
  return (
    <>
      <PageHeader
        title="Time Planner"
        description="Daily screen-time goals, scheduled focus sessions, and planned vs. actual time."
      />
      <Card>
        <EmptyState title="No planned tasks or sessions yet">
          Create daily productivity targets and focus blocks. DigitalPulse tracks actual application
          usage alongside your schedule to measure goal completion.
        </EmptyState>
      </Card>
    </>
  );
}
