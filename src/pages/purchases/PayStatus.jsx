import { Badge } from '../../components/Feedback';

export const PAY_STATUS = {
  paid: { label: 'Paid', tone: 'success' },
  partial: { label: 'Partly paid', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'neutral' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Payment status of a purchase bill (cancelled bills show "Cancelled"). */
export default function PayStatus({ status }) {
  const s = PAY_STATUS[status] || PAY_STATUS.unpaid;
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}
