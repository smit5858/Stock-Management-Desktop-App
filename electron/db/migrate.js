'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('../errors');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  const migrations = fs
    .readdirSync(dir)
    .map((file) => {
      const m = FILE_RE.exec(file);
      return m ? { version: Number(m[1]), name: m[2], file: path.join(dir, file) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);

  const seen = new Set();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

/** Fingerprint of a migration file (line endings normalised, so git's CRLF/LF does not matter). */
function checksum(sql) {
  const normalised = sql.split('\r\n').join('\n');
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

function migrationLabel(m) {
  return `${String(m.version).padStart(3, '0')}_${m.name}`;
}

/**
 * Creates schema_migrations if needed, refuses a newer or mismatching DB, and returns the
 * migrations that still have to be applied (in order).
 */
function pendingMigrations(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
    checksum TEXT
  )`);
  const cols = db
    .prepare('PRAGMA table_info(schema_migrations)')
    .all()
    .map((c) => c.name);
  if (!cols.includes('checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');

  const known = listMigrations(dir);
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all();
  const applied = new Set(rows.map((r) => r.version));
  const maxApplied = applied.size ? Math.max(...applied) : 0;
  const maxKnown = known.length ? known[known.length - 1].version : 0;

  if (maxApplied > maxKnown) {
    throw new AppError(
      'This data was created by a newer version of Pragati Car. Please use the newer version of the app.',
      'DB_NEWER',
    );
  }

  // An applied migration whose file has changed means the data was built from a different
  // (development) schema. Refuse instead of failing later with "no such table/column".
  for (const r of rows) {
    const m = known.find((k) => k.version === r.version);
    if (m && r.checksum && r.checksum !== checksum(fs.readFileSync(m.file, 'utf8'))) {
      throw new AppError(
        'This data file was created by a different development version of Pragati Car and does not match this version.',
        'SCHEMA_MISMATCH',
      );
    }
  }
  return known.filter((m) => !applied.has(m.version));
}

/** First line `-- foreign_keys: off` = the file rebuilds tables (SQLite's 12-step procedure). */
function needsForeignKeysOff(sql) {
  return /^\s*--\s*foreign_keys:\s*off\b/i.test(sql);
}

/**
 * Applies one migration in its own transaction (all or nothing). Before COMMIT it runs
 * PRAGMA foreign_key_check and integrity_check; any problem rolls the whole file back.
 * Rebuild migrations run with foreign_keys OFF (it cannot be changed inside a transaction);
 * it is switched back ON in `finally`, whatever happens.
 * Migration files must not contain BEGIN/COMMIT.
 */
function applyMigration(db, m) {
  const sql = fs.readFileSync(m.file, 'utf8');
  const label = migrationLabel(m);
  if (needsForeignKeysOff(sql)) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(sql);
      const fk = db.pragma('foreign_key_check');
      if (fk.length) {
        throw new Error(`${label}: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
      }
      const integrity = db.pragma('integrity_check').map((r) => r.integrity_check);
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        throw new Error(`${label}: integrity check failed: ${integrity.slice(0, 5).join('; ')}`);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        checksum(sql),
      );
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error(`${label}: foreign keys could not be switched back on`);
  }
  return label;
}

/** Applies all pending migrations (no backups; the DB manager wraps this with them). */
function migrate(db, dir = MIGRATIONS_DIR) {
  return pendingMigrations(db, dir).map((m) => applyMigration(db, m));
}

function currentVersion(db) {
  return db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get();
}

module.exports = {
  migrate,
  pendingMigrations,
  applyMigration,
  migrationLabel,
  listMigrations,
  currentVersion,
  MIGRATIONS_DIR,
};
