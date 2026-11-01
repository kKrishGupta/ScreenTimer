import { Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/States.jsx';

export default function DigitalWellbeingPage() {
  return (
    <>
      <PageHeader
        title="Digital Wellbeing"
        description="Healthy technology habits, break reminders, and eye-strain reduction."
      />
      <Card>
        <EmptyState title="No wellbeing alerts active">
          DigitalPulse monitors continuous screen usage and prompts periodic 20-20-20 breaks
          and posture check reminders.
        </EmptyState>
      </Card>
    </>
  );
}
