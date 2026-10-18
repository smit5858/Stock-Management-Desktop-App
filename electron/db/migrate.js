'use strict';

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

/**
 * Applies pending migrations, each in its own transaction (all or nothing per file).
 * Migration files must not contain BEGIN/COMMIT.
 * Returns the names of the migrations applied.
 */
function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  )`);

  const known = listMigrations(dir);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const maxApplied = applied.size ? Math.max(...applied) : 0;
  const maxKnown = known.length ? known[known.length - 1].version : 0;

  if (maxApplied > maxKnown) {
    throw new AppError(
      'This data was created by a newer version of StockApp. Please use the newer version of the app.',
      'DB_NEWER',
    );
  }

  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  const done = [];
  for (const m of known) {
    if (applied.has(m.version)) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(m.version, m.name);
    })();
    done.push(`${String(m.version).padStart(3, '0')}_${m.name}`);
  }
  return done;
}

function currentVersion(db) {
  return db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get();
}

module.exports = { migrate, listMigrations, currentVersion, MIGRATIONS_DIR };
