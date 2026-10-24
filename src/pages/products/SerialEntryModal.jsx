import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ClipboardList, Hash, ScanLine, TriangleAlert, Wand2, X } from 'lucide-react';
import Button from '../../components/Button';
import { Modal } from '../../components/Overlay';
import { Field, Input, Segmented, Textarea, Toggle } from '../../components/Field';
import { Badge } from '../../components/Feedback';
import { useToast } from '../../components/Toast';
import { serialsApi } from '../../api/products';

/**
 * Enter serial numbers for N units: scan/type one by one (Enter = next), paste a list, or
 * auto-generate numbers with a prefix (for units without a printed serial).
 * `required` = exact number needed (or null for "any number ≥ 1").
 * Duplicates are flagged live: red = blocks saving, amber = exists on another product.
 * Remounted (key) per open. onDone({ entries, auto }) / onCancel().
 * `allowIds`: existing serial rows that may appear again (editing a purchase keeps its units).
 */
export default function SerialEntryModal({
  open,
  title,
  productId,
  required,
  initial,
  allowIds = [],
  onDone,
  onCancel,
}) {
  const toast = useToast();
  const [mode, setMode] = useState('scan');
  const [entries, setEntries] = useState(() => initial?.entries || []);
  const [auto, setAuto] = useState(() => initial?.auto || null);
  const [current, setCurrent] = useState('');
  const [current2, setCurrent2] = useState('');
  const [hasSecond, setHasSecond] = useState(() =>
    (initial?.entries || []).some((e) => e.serial_no_2),
  );
  const [paste, setPaste] = useState('');
  const [prefix, setPrefix] = useState(() => initial?.auto?.prefix || 'OLD-');
  const [autoCount, setAutoCount] = useState(() =>
    String(initial?.auto?.count || Math.max((required || 1) - (initial?.entries?.length || 0), 1)),
  );
  const [checks, setChecks] = useState({ key: '', rows: [] });
  const [preview, setPreview] = useState([]);
  const inputRef = useRef(null);
  const secondRef = useRef(null);

  const total = entries.length + (auto ? auto.count : 0);
  const entriesKey = JSON.stringify(entries.map((e) => e.serial_no));

  // Live duplicate check (debounced).
  useEffect(() => {
    if (entries.length === 0) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      serialsApi
        .check(productId ?? null, entries, allowIds)
        .then((rows) => !cancelled && setChecks({ key: entriesKey, rows }))
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey, productId]);

  const rows = checks.key === entriesKey ? checks.rows : [];
  const errorCount = rows.filter((r) => r.error).length;
  const warnCount = rows.filter((r) => r.warning).length;
  const checking = entries.length > 0 && checks.key !== entriesKey;

  // Auto-generate preview.
  useEffect(() => {
    const n = Number(autoCount);
    if (mode !== 'auto' || !Number.isInteger(n) || n < 1 || n > 5000) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      serialsApi
        .previewAuto(prefix, n, productId ?? null)
        .then((list) => !cancelled && setPreview(list))
        .catch(() => !cancelled && setPreview([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mode, prefix, autoCount, productId]);

  function addOne() {
    const serial = current.trim();
    if (!serial) return;
    setEntries((list) => [
      ...list,
      { serial_no: serial, serial_no_2: hasSecond ? current2.trim() : '' },
    ]);
    setCurrent('');
    setCurrent2('');
    inputRef.current?.focus();
  }

  function addPasted() {
    const lines = paste
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [a, b] = l.split(/[,\t]/).map((x) => x.trim());
        return { serial_no: a, serial_no_2: b || '' };
      });
    if (lines.length === 0) return toast.error('Paste one serial number per line.');
    if (lines.some((l) => l.serial_no_2)) setHasSecond(true);
    setEntries((list) => [...list, ...lines]);
    setPaste('');
    setMode('scan');
    toast.success(`${lines.length} serial numbers added to the list.`);
  }

  function useAuto() {
    const n = Number(autoCount);
    if (!Number.isInteger(n) || n < 1) return toast.error('Enter how many numbers to generate.');
    setAuto({ prefix: prefix.trim() || 'SN-', count: n });
    setMode('scan');
  }

  const remaining = required != null ? required - total : null;
  const canSave =
    total > 0 && errorCount === 0 && !checking && (required == null || total === required);

  const firstAuto = useMemo(() => (auto ? preview.slice(0, 1)[0] : null), [auto, preview]);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width="w-[44rem]"
      footer={
        <>
          <span className="mr-auto text-sm text-muted">
            {required != null ? (
              <>
                <strong className={total === required ? 'text-success' : 'text-fg'}>{total}</strong>{' '}
                of {required} entered
              </>
            ) : (
              <>
                <strong className="text-fg">{total}</strong> unit{total === 1 ? '' : 's'}
              </>
            )}
            {errorCount > 0 && <span className="ml-3 text-danger">{errorCount} to fix</span>}
            {warnCount > 0 && <span className="ml-3 text-warning">{warnCount} warning(s)</span>}
          </span>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => onDone({ entries, auto })}>
            Use these serials
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          layoutId="serial-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'scan', label: 'Scan / type', icon: ScanLine },
            { value: 'paste', label: 'Paste list', icon: ClipboardList },
            { value: 'auto', label: 'Auto-generate', icon: Wand2 },
          ]}
        />

        {mode === 'scan' && (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <Field label="Serial number" className="flex-1">
                {(id) => (
                  <Input
                    id={id}
                    ref={inputRef}
                    autoFocus
                    value={current}
                    disabled={remaining === 0}
                    placeholder={remaining === 0 ? 'All units entered' : 'Scan or type, then Enter'}
                    onChange={(e) => setCurrent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (hasSecond && !current2) secondRef.current?.focus();
                        else addOne();
                      }
                    }}
                  />
                )}
              </Field>
              {hasSecond && (
                <Field label="Second number" className="flex-1">
                  {(id) => (
                    <Input
                      id={id}
                      ref={secondRef}
                      value={current2}
                      onChange={(e) => setCurrent2(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addOne();
                        }
                      }}
                    />
                  )}
                </Field>
              )}
              <Button onClick={addOne} disabled={!current.trim() || remaining === 0}>
                Add
              </Button>
            </div>
            <Toggle
              label="Units have a second number (set / box)"
              checked={hasSecond}
              onChange={setHasSecond}
            />
          </div>
        )}

        {mode === 'paste' && (
          <div className="space-y-2">
            <Field label="One serial per line (optionally: serial, second number)">
              {(id) => (
                <Textarea
                  id={id}
                  autoFocus
                  rows={7}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder={'AB12345\nAB12346\nAB12347'}
                  className="font-mono"
                />
              )}
            </Field>
            <Button variant="primary" onClick={addPasted}>
              Add to list
            </Button>
          </div>
        )}

        {mode === 'auto' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              For units without a printed serial (or old stock whose serials can&apos;t be found).
              They are marked &ldquo;auto-generated&rdquo; in the Serials tab.
            </p>
            <div className="flex items-end gap-3">
              <Field label="Prefix">
                {(id) => (
                  <Input
                    id={id}
                    value={prefix}
                    maxLength={12}
                    onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  />
                )}
              </Field>
              <Field label="How many">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={autoCount}
                    onChange={(e) => setAutoCount(e.target.value.replace(/\D/g, ''))}
                  />
                )}
              </Field>
              <Button variant="primary" icon={Hash} onClick={useAuto}>
                Generate
              </Button>
            </div>
            {preview.length > 0 && (
              <p className="text-sm">
                Will create: <span className="font-mono">{preview[0]}</span>
                {preview.length > 1 && (
                  <>
                    {' '}
                    … <span className="font-mono">{preview[preview.length - 1]}</span>
                  </>
                )}
              </p>
            )}
          </div>
        )}

        <div className="max-h-64 overflow-auto rounded-xl border border-border">
          {total === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No serial numbers yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              <AnimatePresence initial={false}>
                {entries.map((e, i) => {
                  const r = rows[i];
                  return (
                    <motion.li
                      key={`${i}-${e.serial_no}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className={`flex items-center gap-3 px-4 py-1.5 text-sm ${r?.error ? 'bg-danger-soft/50' : ''}`}
                    >
                      <span className="w-8 text-xs text-muted">{i + 1}</span>
                      <span className="font-mono">{e.serial_no}</span>
                      {e.serial_no_2 && (
                        <span className="font-mono text-muted">/ {e.serial_no_2}</span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-xs">
                        {r?.error && <span className="text-danger">{r.error}</span>}
                        {!r?.error && r?.warning && (
                          <span className="flex items-center gap-1 text-warning" title={r.warning}>
                            <TriangleAlert size={12} /> {r.warning}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => setEntries((list) => list.filter((_, j) => j !== i))}
                        className="rounded p-1 text-muted hover:bg-danger-soft hover:text-danger"
                      >
                        <X size={13} />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
              {auto && (
                <li className="flex items-center gap-3 bg-primary-soft/40 px-4 py-2 text-sm">
                  <Badge tone="primary">Auto</Badge>
                  <span>
                    {auto.count} number{auto.count === 1 ? '' : 's'} with prefix{' '}
                    <span className="font-mono">{auto.prefix}</span>
                    {firstAuto && <span className="text-muted"> (from {firstAuto})</span>}
                  </span>
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => setAuto(null)}
                    className="ml-auto rounded p-1 text-muted hover:bg-danger-soft hover:text-danger"
                  >
                    <X size={13} />
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
