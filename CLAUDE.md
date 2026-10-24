# Pragati Car: portable offline stock, billing and accounts

Desktop app for a **car accessories shop** in India. It runs **100% offline** from a **USB drive**
on any 64-bit Windows 10/11 PC, with nothing installed. Losing data is the worst possible failure.

Design details (GST maths, number series, products/variants, ledger signs, IPC list):
**docs/DESIGN.md**. Schema: **electron/db/migrations/\*.sql**.

## Stack

- Electron 44 (main process: **CommonJS**), React 19 + Vite 8 (renderer: **ES modules**), **JavaScript only**
- Tailwind CSS v4 via `@tailwindcss/vite` (no tailwind.config.js; theme tokens live in `src/index.css`)
- framer-motion (animation), lucide-react (icons), `@fontsource-variable/inter` (bundled font)
- better-sqlite3 13 (N-API prebuilds, so no native rebuild for Electron); exceljs for xlsx import/export;
  libphonenumber-js (phone validation / formatting, bundled metadata)
- electron-builder (`dir` target → `release/win-unpacked/Pragati Car.exe`), Vitest, ESLint 9, Prettier
- Ask before adding dependencies.

## Commands

- `npm run dev`: Vite dev server + Electron (data goes to `./data`)
- `npm start`: build renderer and run Electron against `dist/`
- `npm test`, `npm run lint`, `npm run format`
- `npm run make-icon`: regenerate `build/icon.ico` + `electron/assets/icon.png` from the default SVG logo
- Dev/test only: `PC_DEV_DATA_DIR=<folder>` runs a second dev instance on a separate data folder
  (ignored in packaged builds).

## Portability rules (critical)

- All data lives in `data/` **next to the exe**. Resolve it via `electron/paths.js` only:
  `PORTABLE_EXECUTABLE_DIR` → `dirname(process.execPath)` when packaged → `<repo>/data` in dev.
- Electron's own profile (`userData`, `sessionData`, `crashDumps`, `logs`) is redirected to
  `data/.electron/` before `app.ready`. Nothing may be written to AppData, home or the registry.
- **Never persist an absolute path** (DB, settings.json, backups). The drive letter changes.
  User files are copied into `data/branding/` or `data/images/` and stored as relative paths.
  They are served to the renderer only via `app-data://files/<relative path>`.
- No network calls of any kind. No CDN fonts or scripts. All http(s) requests are blocked
  except the Vite dev server.

## Data-safety rules (critical; the USB can be pulled at any moment)

- SQLite pragmas: `journal_mode=DELETE`, `synchronous=FULL`, `foreign_keys=ON`.
- Every multi-step write runs in **one `db.transaction()`** inside `electron/services/`.
- Backups: on start (before migrations) and on close, via `db.backup()` to a `.tmp` file,
  `quick_check`, then rename. 30 are kept. Restore takes a `prerestore` backup first and
  removes any stale `app.db-journal`. (DB backups do not include `data/images` / `data/branding`.)
- `PRAGMA integrity_check` runs at startup. If it fails, the app enters recovery mode
  (the Recovery page offers a restore).
- Single-instance lock. The DB is closed cleanly on quit and on Windows session end.
- **Never hard-delete** business records: use `is_deleted = 1`, `is_active = 0` or
  `status = 'cancelled'` + `cancel_reason`. `stock_movements` are append-only (DB triggers).
- Stock is never edited directly. Sellable stock is `SUM(stock_movements.qty_milli)` per **variant**
  at `location = 'main'` (`'defective'` = kept out of sale). For serial-tracked items main must always
  equal the number of `in_stock` serials and defective the number of `defective` serials: change a
  serial's stock status and write its movement(s) in the same transaction. Serial rows and
  `serial_events` are never deleted.
- Money = integer paise, qty = integer milli-units, GST % = integer basis points. No floats.
  Format as ₹ only in the UI (`src/utils/money.js`); main-process parsing is in `services/parse.js`.
- Files written by the app (settings.json, backups, Excel exports, branding, images) go to a temp
  file first, then are renamed.
- `settings.json` holds UI and machine prefs only (theme, sidebar, sound, window).
  Business settings live in the DB `settings` table so they are included in backups.
- Saved invoices are never edited. To change one, cancel it with a reason and issue a new one.
- Migrations: numbered `NNN_name.sql`, each applied in its own transaction. **Before v1.0
  ships to a USB, 001/002 may be edited (then reset the dev `data/`). After that, add new
  migrations only and never edit an applied one.** A DB newer than the app is refused.

## Architecture

```
electron/
  main.js         lifecycle, single-instance, window, protocol, quit → close backup → close DB
  preload.js      window.api: invoke(channel, payload), onAppClosing, onStartupProgress, initialUiPrefs
  paths.js        pure path resolution (testable)
  protocol.js     app-data:// (serves data/branding + data/images only)
  dataFiles.js    copying logo / sound / product images into data/ (atomic, validated)
  logger.js       data/logs/app_YYYY-MM-DD.log (30 days kept)
  settingsFile.js atomic JSON prefs (validated keys only)
  errors.js       AppError(message, code, fields): user-facing; anything else is logged + generic
  db/             index.js (DB manager: startup stages/recovery/restore), connection, migrate, backup
  ipc/            thin handlers: payload → service → {ok,data}. No SQL here. `waitForDb:false` for
                  handlers that must work before/without the DB (prefs, branding, startup).
  services/       business logic + SQL + transactions. No `electron` imports (unit-testable).
  validation/     payload validators (return field errors like 'variants.0.sku'); identity.js =
                  phone / plate / GSTIN / state rules, mirrored in src/utils/identity.js (keep in sync)
src/
  components/     Button, Field (Input/Select/MoneyInput/Toggle/Segmented), Overlay (Modal/Drawer),
                  Feedback (Badge/Skeleton/EmptyState/AnimatedNumber/Tooltip), Toast, Prefs, Branding,
                  CustomerPicker (phone / plate / name + quick add; for Billing), VehicleModelPicker,
                  VirtualList,
                  layout/ (Sidebar, TopBar, CommandPalette), loader/ (startup loader + jingle)
  pages/          Dashboard, Settings, Recovery, products/ (Products, ProductDrawer, modals),
                  parties/ (Parties list, PartyDrawer + tabs, PartyForm, vehicle/merge/import modals),
                  purchases/, sales/ (Billing screen + bill tabs, BillLines, Sales list, SaleDrawer,
                  SaleModals: print preview / cancel / return + exchange / quotation / credit note),
                  warranty/ (Warranty page: search, lists, UnitDrawer, ClaimDrawer, ClaimModals)
  api/ hooks/ utils/
public/theme-init.js  applies the saved theme before first paint
tests/            Vitest. Services are tested against temp DBs (load CJS via createRequire).
```

- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. It never
  touches the filesystem or DB. HashRouter (file:// in production).
- Main process: validate every input. Throw `AppError` for messages the user should see;
  log full details to `data/logs/`.

## UI conventions

- Colours only via semantic tokens (`bg-surface`, `text-muted`, `bg-primary-soft`, `border-border`, …)
  so every screen works in light and dark. Never hard-code slate/indigo shades in pages.
- Animations: short (≤ 250 ms), enter-only for page changes; billing must never wait on one.
  framer-motion respects the "Reduce animations" setting via `MotionConfig`; CSS keyframes are
  disabled by `html.reduce-motion` and `prefers-reduced-motion`.
- Modals/drawers are remounted with a `key` each time they open (no "reset state" effects).
  Escape closes only the topmost overlay.
- Single-key shortcuts (N, /, Enter, arrows) go through `useHotkeys`, which ignores them while
  typing and can be paused while an overlay is open. Global: Alt+1…8, Ctrl+K, Ctrl+B.
- Must look good at 1366×768 and 1920×1080. Billing is keyboard-first. Errors appear as toasts,
  field errors next to inputs.
- Prettier: 2 spaces, single quotes, semicolons, width 100. snake_case keys over IPC (no mapping).

## Build phases

1 foundation ✅ · 1.5 branding & UI ✅ · 2 products/stock + serial numbers ✅ · 3 customers/suppliers/vehicles ✅ ·
4 purchases ✅ · 5 sales/billing/print ✅ · 5.5 Warranty page + claims ✅ ·
6 accounts · 7 reports · 8 settings/PIN/backup UI/dashboard · 9 packaging + USB_SETUP.md
