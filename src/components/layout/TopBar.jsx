import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { DatabaseBackup, Loader2, Monitor, Moon, Search, Sun } from 'lucide-react';
import { navItemFor } from '../../navigation';
import { usePrefs } from '../Prefs';
import { useAppInfo } from '../AppInfo';
import { useToast } from '../Toast';
import { Kbd } from '../Feedback';
import Notifications from './Notifications';
import { backupApi } from '../../api/backup';
import { formatDate } from '../../utils/dates';

const THEMES = {
  light: { icon: Sun, label: 'Light', next: 'dark' },
  dark: { icon: Moon, label: 'Dark', next: 'system' },
  system: { icon: Monitor, label: 'System', next: 'light' },
};

function ThemeButton() {
  const { prefs, setPref } = usePrefs();
  const current = THEMES[prefs.theme] || THEMES.system;
  const Icon = current.icon;
  return (
    <button
      type="button"
      onClick={() => setPref('theme', current.next)}
      title={`Theme: ${current.label} (click to change)`}
      className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={prefs.theme}
          initial={{ y: -16, opacity: 0, rotate: -60 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          exit={{ y: 16, opacity: 0, rotate: 60 }}
          transition={{ duration: 0.2 }}
        >
          <Icon size={18} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function BackupChip() {
  const { info, refresh } = useAppInfo();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function backupNow() {
    setBusy(true);
    try {
      await backupApi.create();
      toast.success('Backup saved.');
      refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const last = info?.last_backup;
  return (
    <button
      type="button"
      onClick={backupNow}
      disabled={busy}
      title="Click to back up now"
      className="flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {busy ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <DatabaseBackup size={16} className={last ? 'text-success' : 'text-warning'} />
      )}
      <span>
        {busy ? 'Backing up…' : last ? `Backup ${formatDate(last.created_at)}` : 'No backup yet'}
      </span>
    </button>
  );
}

export default function TopBar({ onSearch }) {
  const { pathname } = useLocation();
  const item = navItemFor(pathname);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface/80 px-6 backdrop-blur">
      <AnimatePresence mode="wait" initial={false}>
        <motion.h1
          key={item.path}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.12 }}
          className="min-w-0 truncate text-lg font-semibold"
        >
          {item.label}
        </motion.h1>
      </AnimatePresence>

      <button
        type="button"
        onClick={onSearch}
        className="ml-auto flex h-9 w-72 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-muted transition-colors hover:border-primary/40 xl:w-96"
      >
        <Search size={16} />
        <span className="flex-1 text-left">Search products, serials, claims…</span>
        <Kbd>Ctrl K</Kbd>
      </button>

      <BackupChip />
      <Notifications />
      <ThemeButton />
    </header>
  );
}
