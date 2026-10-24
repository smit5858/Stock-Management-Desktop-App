import { HardDrive, TriangleAlert } from 'lucide-react';
import { useAppInfo } from './AppInfo';

export default function StatusBar() {
  const { info } = useAppInfo();
  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-border bg-surface px-4 text-xs text-muted">
      <span className="flex min-w-0 items-center gap-1.5" title={info?.data_dir}>
        <HardDrive size={13} className="shrink-0" />
        <span className="truncate">{info?.data_dir ?? '…'}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-medium text-warning">
        <TriangleAlert size={13} />
        Always close the app before removing the USB drive.
      </span>
    </footer>
  );
}
