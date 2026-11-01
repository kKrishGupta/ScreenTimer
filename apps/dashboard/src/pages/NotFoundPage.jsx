import { Link } from 'react-router';
import { EmptyState } from '../components/ui/States.jsx';

export default function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link className="text-accent-400 hover:underline" to="/">
        Back to overview
      </Link>
    </EmptyState>
  );
}

