import { useState } from 'react';
import Button from '../components/Button';
import { useAppInfo } from '../components/AppInfo';
import { useToast } from '../components/Toast';
import { appApi } from '../api/app';
import { backupApi } from '../api/backup';
import { formatBytes, formatDate } from '../utils/dates';

function InfoCard({ label, value, title }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs tracking-wide text-slate-500 uppercase">{label}</div>
      <div className="mt-1 truncate text-base font-semibold" title={title}>
        {value}
      </div>
    </div>
  );
}

// Phase 1: system status only. Sales/stock widgets come in Phase 8.
export default function Dashboard() {
  const { info, refresh } = useAppInfo();
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
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <InfoCard label="Data folder" value={info?.data_dir ?? '…'} title={info?.data_dir} />
        <InfoCard label="Database size" value={info ? formatBytes(info.db_size_bytes) : '…'} />
        <InfoCard
          label="Last backup"
          value={info?.last_backup ? formatDate(info.last_backup.created_at) : 'None yet'}
        />
        <InfoCard label="Backups kept" value={info ? `${info.backup_count} of 30` : '…'} />
      </div>

      <div className="flex gap-2">
        <Button variant="primary" onClick={backupNow} disabled={busy}>
          {busy ? 'Backing up…' : 'Backup now'}
        </Button>
        <Button onClick={exportCopy}>Save a copy elsewhere…</Button>
        <Button onClick={() => appApi.openDataFolder().catch(toast.error)}>Open data folder</Button>
      </div>

      <p className="text-xs text-slate-400">
        StockApp {info?.version} · Electron {info?.electron_version} · schema v
        {info?.schema_version}
      </p>
    </div>
  );
}
