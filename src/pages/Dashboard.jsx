import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlarmClock,
  Archive,
  DatabaseBackup,
  FolderOpen,
  HardDrive,
  History,
  CalendarDays,
  ClipboardList,
  IndianRupee,
  PackageCheck,
  ReceiptText,
  Save,
  ShieldAlert,
  Truck,
  Wallet,
} from 'lucide-react';
import Button from '../components/Button';
import { Badge, Skeleton } from '../components/Feedback';
import { useAppInfo } from '../components/AppInfo';
import { useToast } from '../components/Toast';
import { useBranding } from '../components/Branding';
import { appApi } from '../api/app';
import { backupApi } from '../api/backup';
import { purchasesApi } from '../api/purchases';
import { salesApi } from '../api/sales';
import { warrantyApi } from '../api/warranty';
import PayStatus from './purchases/PayStatus';
import { formatMoney } from '../utils/money';
import { formatBytes, formatDate } from '../utils/dates';

const list = { animate: { transition: { staggerChildren: 0.05 } } };
const item = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22 } },
};

function InfoCard({
  icon: Icon,
  label,
  value,
  title,
  sub,
  onClick,
  tone = 'text-primary bg-primary-soft',
}) {
  return (
    <motion.div
      variants={item}
      whileHover={{ y: -2 }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      className={`rounded-2xl border border-border bg-surface p-5 shadow-sm ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-center gap-3">
        <div className={`rounded-xl p-2.5 ${tone}`}>
          <Icon size={18} />
        </div>
        <div className="text-xs font-medium tracking-wide text-muted uppercase">{label}</div>
      </div>
      <div className="mt-3 truncate text-lg font-semibold" title={title}>
        {value ?? <Skeleton className="h-6 w-32" />}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </motion.div>
  );
}

// Sales today / this month, recent invoices, payables and system status.
export default function Dashboard() {
  const { info, refresh } = useAppInfo();
  const navigate = useNavigate();
  const [payables, setPayables] = useState(null);
  const [sales, setSales] = useState(null);
  const [recent, setRecent] = useState(null);
  const [claims, setClaims] = useState(null);
  useEffect(() => {
    warrantyApi
      .alerts()
      .then(setClaims)
      .catch(() => {});
  }, []);
  useEffect(() => {
    salesApi
      .stats()
      .then(setSales)
      .catch(() => {});
    salesApi
      .recent(8)
      .then(setRecent)
      .catch(() => {});
  }, []);
  useEffect(() => {
    purchasesApi
      .payables()
      .then(setPayables)
      .catch(() => {});
  }, []);
  const { businessName } = useBranding();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function backupNow() {
    setBusy(true);
    try {
      const b = await backupApi.create();
      toast.success(`Backup saved: ${b.file_name}`);
      refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function exportCopy() {
    try {
      const result = await backupApi.exportTo();
      if (result.saved) toast.success(`Copy saved to ${result.file_path}`);
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <h2 className="text-2xl font-bold tracking-tight">Welcome to {businessName}</h2>
        <p className="text-muted">
          Press Alt+2 to start billing. Stock and accounts highlights come with later modules.
        </p>
      </motion.div>

      <motion.div
        variants={list}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 gap-4 xl:grid-cols-4"
      >
        <InfoCard
          icon={CalendarDays}
          label="Today's sales"
          value={sales && formatMoney(sales.today_amount)}
          sub={
            sales &&
            `${sales.today_bills} bill${sales.today_bills === 1 ? '' : 's'} · cash ${formatMoney(sales.today_by_mode.cash)} · UPI ${formatMoney(sales.today_by_mode.upi)}`
          }
          onClick={() => navigate('/sales')}
        />
        <InfoCard
          icon={ReceiptText}
          label="This month"
          value={sales && formatMoney(sales.month_amount)}
          sub={sales && `${sales.month_bills} bills`}
          tone="text-success bg-success-soft"
          onClick={() => navigate('/sales')}
        />
        <InfoCard
          icon={Wallet}
          label="Pending from customers"
          value={sales && formatMoney(sales.receivable)}
          tone="text-warning bg-warning-soft"
          onClick={() => navigate('/parties')}
        />
        <InfoCard
          icon={IndianRupee}
          label="Total payable (suppliers)"
          value={payables && formatMoney(payables.total_payable)}
          tone="text-warning bg-warning-soft"
          onClick={() => navigate('/parties?tab=suppliers')}
        />
        <InfoCard
          icon={AlarmClock}
          label="Overdue payable"
          value={payables && formatMoney(payables.overdue_payable)}
          sub={
            payables &&
            `${payables.overdue_bills} bill${payables.overdue_bills === 1 ? '' : 's'} past due date`
          }
          tone="text-danger bg-danger-soft"
          onClick={() => navigate('/purchases')}
        />
      </motion.div>

      <motion.div
        variants={list}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 gap-4 xl:grid-cols-4"
      >
        <InfoCard
          icon={ClipboardList}
          label="Open warranty claims"
          value={claims && String(claims.open_claims)}
          tone="text-info bg-info-soft"
          onClick={() => navigate('/warranty?tab=open')}
        />
        <InfoCard
          icon={PackageCheck}
          label="Ready for pickup"
          value={claims && String(claims.ready_for_pickup)}
          sub={claims && claims.ready_for_pickup ? 'Call the customers' : null}
          tone="text-success bg-success-soft"
          onClick={() => navigate('/warranty?tab=open&status=ready')}
        />
        <InfoCard
          icon={Truck}
          label="Overdue at supplier"
          value={claims && String(claims.overdue_at_supplier)}
          sub={
            claims && claims.overdue[0]
              ? `Oldest: ${claims.overdue[0].claim_no} · ${claims.overdue[0].supplier_name}`
              : null
          }
          tone={
            claims && claims.overdue_at_supplier
              ? 'text-danger bg-danger-soft'
              : 'text-muted bg-surface-2'
          }
          onClick={() => navigate('/warranty?tab=open&overdue=1')}
        />
        <InfoCard
          icon={ShieldAlert}
          label="Warranties ending this month"
          value={claims && String(claims.expiring_this_month)}
          tone="text-warning bg-warning-soft"
          onClick={() => navigate('/warranty?tab=expiring')}
        />
      </motion.div>

      {recent && recent.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Recent invoices</h3>
            <Button size="sm" variant="ghost" onClick={() => navigate('/sales')}>
              All bills
            </Button>
          </div>
          <ul className="divide-y divide-border text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/sales?open=${r.id}`)}
                  className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-surface-2"
                >
                  <span className="w-24 font-medium">{r.invoice_no}</span>
                  <span className="w-24 text-muted">{formatDate(r.invoice_date)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {r.customer_name}
                    {r.vehicle_no ? <span className="text-muted"> · {r.vehicle_no}</span> : null}
                  </span>
                  {r.status === 'cancelled' ? (
                    <Badge tone="danger">Cancelled</Badge>
                  ) : (
                    <PayStatus status={r.pay_status} />
                  )}
                  <span className="w-28 text-right font-medium tabular-nums">
                    {formatMoney(r.grand_total)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <motion.div
        variants={list}
        initial="initial"
        animate="animate"
        className="grid grid-cols-2 gap-4 xl:grid-cols-4"
      >
        <InfoCard
          icon={HardDrive}
          label="Data folder"
          value={info?.data_dir}
          title={info?.data_dir}
        />
        <InfoCard
          icon={Archive}
          label="Database size"
          value={info && formatBytes(info.db_size_bytes)}
          tone="text-success bg-success-soft"
        />
        <InfoCard
          icon={History}
          label="Last backup"
          value={info && (info.last_backup ? formatDate(info.last_backup.created_at) : 'None yet')}
          tone="text-warning bg-warning-soft"
        />
        <InfoCard
          icon={DatabaseBackup}
          label="Backups kept"
          value={info && `${info.backup_count} of 30`}
        />
      </motion.div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={DatabaseBackup} onClick={backupNow} disabled={busy}>
          {busy ? 'Backing up…' : 'Backup now'}
        </Button>
        <Button icon={Save} onClick={exportCopy}>
          Save a copy elsewhere…
        </Button>
        <Button icon={FolderOpen} onClick={() => appApi.openDataFolder().catch(toast.error)}>
          Open data folder
        </Button>
      </div>

      <p className="text-xs text-muted">
        Pragati Car {info?.version} · Electron {info?.electron_version} · schema v
        {info?.schema_version}
      </p>
    </div>
  );
}
