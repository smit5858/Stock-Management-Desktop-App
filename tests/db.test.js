import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { require, tempDir, testPaths } from './helpers.js';

const { openDatabase, integrityCheck, quickCheckFile } = require('../electron/db/connection.js');
const { migrate, currentVersion, MIGRATIONS_DIR } = require('../electron/db/migrate.js');
const backup = require('../electron/db/backup.js');

const open = [];
function freshDb() {
  const paths = testPaths();
  const db = openDatabase(paths.dbFile);
  open.push(db);
  migrate(db);
  return { db, paths };
}

afterEach(() => {
  while (open.length) {
    const db = open.pop();
    if (db.open) db.close();
  }
});

describe('connection', () => {
  it('applies USB-safe pragmas', () => {
    const { db } = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(integrityCheck(db).ok).toBe(true);
  });

  it('refuses a file that is not a database', () => {
    const file = path.join(tempDir(), 'app.db');
    fs.writeFileSync(file, 'this is not sqlite '.repeat(100));
    expect(() => openDatabase(file)).toThrow();
    expect(quickCheckFile(file)).toBe(false);
  });
});

describe('migrations', () => {
  it('creates the schema and seed data once', () => {
    const { db } = freshDb();
    expect(currentVersion(db)).toBe(2);
    expect(migrate(db)).toEqual([]); // second run applies nothing
    const count = (sql) => db.prepare(sql).pluck().get();
    expect(count('SELECT COUNT(*) FROM sequences')).toBe(6);
    expect(db.prepare('SELECT rate_bp FROM gst_rates ORDER BY sort_order').pluck().all()).toEqual([
      0, 500, 1800, 4000,
    ]);
    expect(count('SELECT name FROM parties WHERE is_system = 1')).toBe('Cash Customer');
    expect(count('SELECT COUNT(*) FROM accounts')).toBe(3);
  });

  it('refuses a database from a newer app version', () => {
    const { db } = freshDb();
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (999, 'future')").run();
    expect(() => migrate(db)).toThrow(/newer version/);
  });

  it('rolls back a failing migration completely', () => {
    const { db } = freshDb();
    const dir = tempDir();
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    }
    fs.writeFileSync(
      path.join(dir, '003_bad.sql'),
      'CREATE TABLE half_done (a INTEGER); INSERT INTO no_such_table VALUES (1);',
    );
    expect(() => migrate(db, dir)).toThrow();
    expect(currentVersion(db)).toBe(2);
    const exists = db
      .prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_done'")
      .pluck()
      .get();
    expect(exists).toBe(0);
  });
});

describe('schema rules', () => {
  it('keeps stock movements append-only', () => {
    const { db } = freshDb();
    const productId = db
      .prepare("INSERT INTO products (name) VALUES ('Pen')")
      .run().lastInsertRowid;
    const id = db
      .prepare(
        "INSERT INTO stock_movements (product_id, date, type, qty_milli) VALUES (?, '2026-10-18', 'opening', 5000)",
      )
      .run(productId).lastInsertRowid;
    expect(() =>
      db.prepare('UPDATE stock_movements SET qty_milli = 1 WHERE id = ?').run(id),
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM stock_movements WHERE id = ?').run(id)).toThrow(
      /append-only/,
    );
    const stock = db
      .prepare('SELECT stock_milli FROM v_product_stock WHERE product_id = ?')
      .pluck()
      .get(productId);
    expect(stock).toBe(5000);
  });

  it('enforces foreign keys and unique invoice numbers per series', () => {
    const { db } = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO stock_movements (product_id, date, type, qty_milli) VALUES (999, '2026-10-18', 'opening', 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    const insertSale =
      db.prepare(`INSERT INTO sales (invoice_no, series, seq_no, invoice_date, bill_type,
      price_mode, bill_title, party_id, place_of_supply_code)
      VALUES (?, 'sale_gst', ?, '2026-10-18', 'gst', 'exclusive', 'Tax Invoice', 1, '24')`);
    insertSale.run('GST-0001', 1);
    expect(() => insertSale.run('GST-0001b', 1)).toThrow(/UNIQUE/);
  });

  it('updates updated_at automatically', () => {
    const { db } = freshDb();
    db.prepare("UPDATE parties SET updated_at = '2000-01-01 00:00:00' WHERE id = 1").run();
    db.prepare("UPDATE parties SET phone = '99999' WHERE id = 1").run();
    const updated = db.prepare('SELECT updated_at FROM parties WHERE id = 1').pluck().get();
    expect(updated).not.toBe('2000-01-01 00:00:00');
  });
});

describe('backups', () => {
  it('creates a verified backup with the expected name', async () => {
    const { db, paths } = freshDb();
    const b = await backup.createBackup(db, paths.backupsDir, 'manual');
    expect(b.file_name).toMatch(backup.BACKUP_RE);
    expect(b.reason).toBe('manual');
    const file = path.join(paths.backupsDir, b.file_name);
    expect(quickCheckFile(file)).toBe(true);
    expect(fs.readdirSync(paths.backupsDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('keeps only the newest 30', () => {
    const dir = tempDir();
    for (let i = 1; i <= 35; i++) {
      fs.writeFileSync(
        path.join(
          dir,
          `app_2026-01-${String((i % 28) + 1).padStart(2, '0')}_10-00-${String(i).padStart(2, '0')}_start.db`,
        ),
        '',
      );
    }
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), '');
    backup.rotate(dir);
    const left = backup.listBackups(dir);
    expect(left).toHaveLength(30);
    expect(fs.existsSync(path.join(dir, 'unrelated.txt'))).toBe(true);
  });

  it('rejects backup names that try to escape the folder', () => {
    const dir = tempDir();
    expect(() => backup.resolveBackupFile(dir, '../app.db')).toThrow(/Invalid/);
    expect(() => backup.resolveBackupFile(dir, 'app_2026-01-01_10-00-00_manual.db')).toThrow(
      /no longer exists/,
    );
  });

  it('restores over a DB file and removes a stale journal', async () => {
    const { db, paths } = freshDb();
    db.prepare("UPDATE settings SET value = 'Before' WHERE key = 'business_name'").run();
    const b = await backup.createBackup(db, paths.backupsDir, 'manual');
    db.prepare("UPDATE settings SET value = 'After' WHERE key = 'business_name'").run();
    db.close();

    fs.writeFileSync(`${paths.dbFile}-journal`, 'stale');
    backup.replaceDbFile(path.join(paths.backupsDir, b.file_name), paths.dbFile);
    expect(fs.existsSync(`${paths.dbFile}-journal`)).toBe(false);

    const reopened = openDatabase(paths.dbFile);
    open.push(reopened);
    const name = reopened
      .prepare("SELECT value FROM settings WHERE key = 'business_name'")
      .pluck()
      .get();
    expect(name).toBe('Before');
  });

  it('refuses to restore a damaged backup', () => {
    const paths = testPaths();
    const bad = path.join(paths.backupsDir, 'app_2026-01-01_10-00-00_manual.db');
    fs.writeFileSync(bad, 'garbage'.repeat(200));
    fs.writeFileSync(paths.dbFile, 'original');
    expect(() => backup.replaceDbFile(bad, paths.dbFile)).toThrow(/damaged/);
    expect(fs.readFileSync(paths.dbFile, 'utf8')).toBe('original');
  });
});
