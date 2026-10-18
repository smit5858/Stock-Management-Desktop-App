'use strict';

const Database = require('better-sqlite3');

/**
 * Opens the database with USB-safe pragmas:
 * - DELETE journal (no -wal/-shm files left behind on a removable drive)
 * - synchronous=FULL (every commit is flushed to the device)
 */
function openDatabase(file, { fileMustExist = false } = {}) {
  const db = new Database(file, { fileMustExist });
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function integrityCheck(db) {
  const messages = db.pragma('integrity_check').map((row) => row.integrity_check);
  return { ok: messages.length === 1 && messages[0] === 'ok', messages: messages.slice(0, 20) };
}

/** Opens a file read-only and runs quick_check. Returns false for any failure. */
function quickCheckFile(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check').map((row) => row.quick_check);
    return rows.length === 1 && rows[0] === 'ok';
  } catch {
    return false;
  } finally {
    if (db && db.open) db.close();
  }
}

function closeDatabase(db) {
  if (db && db.open) db.close();
}

module.exports = { openDatabase, integrityCheck, quickCheckFile, closeDatabase };
