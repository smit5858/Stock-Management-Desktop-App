function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local date as 'YYYY-MM-DD' (the format stored in the DB). */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '2026-10-18' → '18-10-2026'; '2026-10-18 11:42:05' → '18-10-2026 11:42'. */
export function formatDate(value) {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  return m[4] ? `${date} ${m[4]}:${m[5]}` : date;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** '2026-10-18 11:42:05' → '18-10-2026 11:42:05' (to tell apart backups made in the same minute). */
export function formatDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value || '');
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` : formatDate(value);
}
