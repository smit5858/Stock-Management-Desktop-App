import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FolderOpen, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { Badge } from '../components/Feedback';
import { useToast } from '../components/Toast';
import { appApi } from '../api/app';
import { backupApi } from '../api/backup';
import { formatBytes, formatDateTime } from '../utils/dates';

const TITLES = {
  missing_db: 'Data file not found',
  integrity_failed: 'The data file is damaged',
  open_failed: 'The data file could not be opened',
  db_newer: 'This data needs a newer version of Pragati Car',
  schema_mismatch: 'This data does not match this version of the app',
  migration_failed: 'Updating the data file failed',
};

const REASONS = {
  start: 'App start',
  close: 'App close',
  manual: 'Manual',
  prerestore: 'Before restore',
  damaged: 'Damaged copy',
  premigration: 'Before update',
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
    <div className="h-full overflow-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-3xl space-y-5 p-8"
      >
        <div className="flex gap-4 rounded-2xl border border-danger/30 bg-danger-soft p-5">
          <ShieldAlert className="shrink-0 text-danger" size={28} />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-danger">
              {TITLES[status.state] ?? 'Problem'}
            </h1>
            <p className="mt-1">{status.message}</p>
            {status.details?.length > 0 && (
              <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-surface/70 p-2 text-xs">
                {status.details.join('\n')}
              </pre>
            )}
          </div>
        </div>

        {canRestore && (
          <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <h2 className="border-b border-border px-5 py-3 font-semibold">
              Restore from a backup (newest first)
            </h2>
            {backups.length === 0 ? (
              <p className="px-5 py-4 text-muted">No backups found in the backups folder.</p>
            ) : (
              <ul className="max-h-96 divide-y divide-border overflow-auto">
                {backups.map((b) => (
                  <li
                    key={b.file_name}
                    className="flex items-center gap-4 px-5 py-2.5 hover:bg-surface-2"
                  >
                    <span className="w-44 font-medium">{formatDateTime(b.created_at)}</span>
                    <Badge tone={b.reason === 'damaged' ? 'danger' : 'neutral'}>
                      {REASONS[b.reason] ?? b.reason}
                    </Badge>
                    <span className="w-20 text-muted">{formatBytes(b.size_bytes)}</span>
                    <Button
                      className="ml-auto"
                      size="sm"
                      icon={RotateCcw}
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
            <Button icon={Sparkles} disabled={busy} onClick={() => run(appApi.startFresh)}>
              Start with empty data
            </Button>
          )}
          <Button icon={FolderOpen} onClick={() => appApi.openDataFolder().catch(toast.error)}>
            Open data folder
          </Button>
        </div>

        <ConfirmDialog
          open={Boolean(selected)}
          title="Restore this backup?"
          confirmLabel="Restore"
          busy={busy}
          onCancel={() => setSelected(null)}
          onConfirm={() => run(() => backupApi.restore(selected.file_name))}
        >
          Your data will be replaced with the backup from{' '}
          <strong className="text-fg">{selected && formatDateTime(selected.created_at)}</strong>.
          The current data file is kept as a separate copy in the backups folder.
        </ConfirmDialog>
      </motion.div>
    </div>
  );
}
