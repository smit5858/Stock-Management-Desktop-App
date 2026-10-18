import { useAppInfo } from './AppInfo';
import { formatDate } from '../utils/dates';

export default function StatusBar() {
  const { info } = useAppInfo();
  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-slate-200 bg-white px-4 text-xs text-slate-500">
      <span className="truncate" title={info?.data_dir}>
        Data: {info?.data_dir ?? '…'}
      </span>
      <span className="shrink-0">
        Last backup: {info?.last_backup ? formatDate(info.last_backup.created_at) : 'none yet'}
      </span>
      <span className="ml-auto shrink-0 font-medium text-amber-700">
        ⚠ Always close the app before removing the USB drive.
      </span>
    </footer>
  );
}
