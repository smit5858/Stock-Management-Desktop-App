import { useEffect, useState } from 'react';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { appApi } from '../api/app';
import { backupApi } from '../api/backup';
import { formatBytes, formatDateTime } from '../utils/dates';

const TITLES = {
  missing_db: 'Data file not found',
  integrity_failed: 'The data file is damaged',
  open_failed: 'The data file could not be opened',
  db_newer: 'This data needs a newer version of StockApp',
  migration_failed: 'Updating the data file failed',
};

const REASONS = {
  start: 'App start',
  close: 'App close',
  manual: 'Manual',
  prerestore: 'Before restore',
  damaged: 'Damaged copy',
};

/** Shown instead of the app when the database is not usable. Nothing here writes business data. */
export default function Recovery({ status, onRecovered }) {
  const toast = useToast();
  const [backups, setBackups] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backupApi.list().then(setBackups).catch(toast.error);
  }, [toast]);

  async function run(action) {
    setBusy(true);
    try {
      const result = await action();
      if (result.state === 'ok') onRecovered();
      else toast.error(result.message || 'The data could not be opened.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      setSelected(null);
    }
  }

  const canRestore = status.state !== 'db_newer';

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-8">
      <div className="rounded-lg border border-red-200 bg-red-50 p-5">
        <h1 className="text-lg font-semibold text-red-900">{TITLES[status.state] ?? 'Problem'}</h1>
        <p className="mt-1 text-red-800">{status.message}</p>
        {status.details?.length > 0 && (
          <pre className="mt-3 max-h-32 overflow-auto rounded bg-white/70 p-2 text-xs text-red-900">
            {status.details.join('\n')}
          </pre>
        )}
      </div>

      {canRestore && (
        <section className="rounded-lg border border-slate-200 bg-white">
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">
            Restore from a backup (newest first)
          </h2>
          {backups.length === 0 ? (
            <p className="px-4 py-3 text-slate-500">No backups found in the backups folder.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-auto">
              {backups.map((b) => (
                <li key={b.file_name} className="flex items-center gap-4 px-4 py-2">
                  <span className="w-40">{formatDateTime(b.created_at)}</span>
                  <span className="w-28 text-slate-500">{REASONS[b.reason] ?? b.reason}</span>
                  <span className="w-20 text-slate-500">{formatBytes(b.size_bytes)}</span>
                  <Button
                    className="ml-auto"
                    disabled={busy || b.reason === 'damaged'}
                    onClick={() => setSelected(b)}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="flex gap-2">
        {status.state === 'missing_db' && (
          <Button disabled={busy} onClick={() => run(appApi.startFresh)}>
            Start with empty data
          </Button>
        )}
        <Button onClick={() => appApi.openDataFolder().catch(toast.error)}>Open data folder</Button>
      </div>

      {selected && (
        <ConfirmDialog
          title="Restore this backup?"
          confirmLabel="Restore"
          busy={busy}
          onCancel={() => setSelected(null)}
          onConfirm={() => run(() => backupApi.restore(selected.file_name))}
        >
          Your data will be replaced with the backup from{' '}
          <strong>{formatDateTime(selected.created_at)}</strong>. The current data file is kept as a
          separate copy in the backups folder.
        </ConfirmDialog>
      )}
    </div>
  );
}
