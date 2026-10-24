import { Construction } from 'lucide-react';
import { EmptyState } from '../components/Feedback';

export default function ComingSoon({ title, phase }) {
  return (
    <EmptyState icon={Construction} title={title}>
      This section is built in Phase {phase}.
    </EmptyState>
  );
}
