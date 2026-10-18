# StockApp — portable offline stock, sales & accounts

Desktop app for a small Indian shop. It runs **100% offline** from a **USB drive** on any 64-bit
Windows 10/11 PC, with nothing installed. Losing data is the worst possible failure.

Design details (GST maths, number series, ledger signs, IPC list): **docs/DESIGN.md**.
Schema: **electron/db/migrations/\*.sql**.

## Stack

- Electron 44 (main process: **CommonJS**), React 19 + Vite 8 (renderer: **ES modules**), **JavaScript only**
- Tailwind CSS v4 via `@tailwindcss/vite` (no tailwind.config.js; theme lives in `src/index.css`)
- better-sqlite3 13. It ships N-API prebuilds, so it needs no native rebuild for Electron.
- electron-builder (`dir` target → `win-unpacked`), Vitest, ESLint 9 (flat config), Prettier
- Ask before adding dependencies. Excel export will use `exceljs` (not `xlsx`).

## Commands

- `npm run dev`: Vite dev server + Electron (data goes to `./data`)
- `npm start`: build renderer and run Electron against `dist/`
- `npm test`, `npm run lint`, `npm run format`

## Portability rules (critical)

- All data lives in `data/` **next to the exe**. Resolve it via `electron/paths.js` only:
  `PORTABLE_EXECUTABLE_DIR` → `dirname(process.execPath)` when packaged → `<repo>/data` in dev.
- Electron's own profile (`userData`, `sessionData`, `crashDumps`, `logs`) is redirected to
  `data/.electron/` before `app.ready`. Nothing may be written to AppData, home or the registry.
- **Never persist an absolute path** (DB, settings.json, backups). The drive letter changes.
- No network calls of any kind. No CDN fonts or scripts. All http(s) requests are blocked
  except the Vite dev server.

## Data-safety rules (critical; the USB can be pulled at any moment)

- SQLite pragmas: `journal_mode=DELETE`, `synchronous=FULL`, `foreign_keys=ON`.
- Every multi-step write runs in **one `db.transaction()`** inside `electron/services/`.
- Backups: on start (before migrations) and on close, via `db.backup()` to a `.tmp` file,
  `quick_check`, then rename. 30 are kept. Restore takes a `prerestore` backup first and
  removes any stale `app.db-journal`.
- `PRAGMA integrity_check` runs at startup. If it fails, the app enters recovery mode
  (the Recovery page offers a restore).
- Single-instance lock. The DB is closed cleanly on quit and on Windows session end.
- **Never hard-delete** business records: use `is_deleted = 1` or `status = 'cancelled'` +
  `cancel_reason`. `stock_movements` are append-only; reversals are new rows.
- Stock is never edited directly. It is `SUM(stock_movements.qty_milli)`.
- Money = integer paise, qty = integer milli-units, GST % = integer basis points. No floats.
  Format as ₹ only in the UI (`src/utils/money.js`).
- `settings.json` (UI and machine preferences only) is written atomically (temp + rename).
  Business settings live in the DB `settings` table so they are included in backups.
- Saved invoices are never edited. To change one, cancel it with a reason and issue a new one.
- Migrations: numbered `NNN_name.sql`, each applied in its own transaction. **Before v1.0
  ships to a USB, 001/002 may be edited. After that, add new migrations only and never
  edit an applied one.** A DB newer than the app is refused.

## Architecture

```
electron/
  main.js         lifecycle, single-instance, window, quit → close backup → close DB
  preload.js      exposes only window.api.invoke(channel, payload) (sandboxed)
  paths.js        pure path resolution (testable)
  logger.js       data/logs/app_YYYY-MM-DD.log (30 days kept)
  settingsFile.js atomic JSON prefs
  errors.js       AppError = user-facing message; anything else is logged + generic message
  db/             index.js (DB manager: startup/recovery/restore), connection.js, migrate.js, backup.js, migrations/
  ipc/            thin handlers: validate payload → call service → {ok,data}. No SQL here.
  services/       business logic + SQL + transactions. No `electron` imports (unit-testable).
  validation/     payload validators
  print/ export/  invoice templates; CSV/XLSX/PDF writers
src/              React renderer: pages/, components/, hooks/, utils/, api/ (wrappers around window.api)
tests/            Vitest. Services are tested against temp DBs (load CJS via createRequire).
```

- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. It never
  touches the filesystem or DB. HashRouter (file:// in production).
- Main process: validate every input. Throw `AppError` for messages the user should see;
  log full details to `data/logs/`.

## Conventions

- Prettier: 2 spaces, single quotes, semicolons, width 100.
- DB columns use snake_case; JS objects returned over IPC use the same snake_case keys (no mapping layer).
- UI must work at 1366×768. Billing is keyboard-first.
- User-facing errors appear as toasts.

## Build phases

1 foundation ✅ · 2 products/stock · 3 parties · 4 purchases · 5 sales/billing/print ·
6 accounts · 7 reports · 8 settings/PIN/backup UI/dashboard · 9 packaging + USB_SETUP.md
