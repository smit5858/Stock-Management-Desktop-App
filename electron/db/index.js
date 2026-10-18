'use strict';

const fs = require('fs');
const { openDatabase, integrityCheck, closeDatabase } = require('./connection');
const { migrate } = require('./migrate');
const backup = require('./backup');
const logger = require('../logger');
const { AppError } = require('../errors');

/**
 * Owns the single DB connection and the startup / recovery / restore sequence.
 *
 * status.state:
 *   'starting'          not finished yet
 *   'ok'                DB open and migrated
 *   'missing_db'        app.db is gone but backups exist (likely user mistake), so the user chooses
 *   'integrity_failed'  integrity_check failed, so restore is offered
 *   'open_failed'       file could not be opened as a database
 *   'db_newer'          created by a newer app version
 *   'migration_failed'  upgrade failed (the migration that failed was rolled back)
 */
let db = null;
let paths = null;
let status = { state: 'starting' };

function setStatus(state, message = '', details = []) {
  status = { state, message, details };
  if (state !== 'ok') logger.warn(`Database status: ${state}`, message, details);
  return status;
}

/** Opens app.db, checks it, backs it up and migrates it. Assumes no connection is open. */
async function openAndPrepare({ backupReason }) {
  const existed = fs.existsSync(paths.dbFile);

  try {
    db = openDatabase(paths.dbFile);
  } catch (err) {
    db = null;
    logger.error('Opening database failed', err);
    return setStatus('open_failed', 'It may be damaged, or it is not a StockApp data file.', [
      err.message,
    ]);
  }

  if (existed) {
    const check = integrityCheck(db);
    if (!check.ok) {
      closeDatabase(db);
      db = null;
      return setStatus(
        'integrity_failed',
        'The data file failed its safety check.',
        check.messages,
      );
    }
    if (backupReason) {
      try {
        await backup.createBackup(db, paths.backupsDir, backupReason);
      } catch (err) {
        // Keep working, but make sure it is visible in the log.
        logger.error('Automatic backup failed', err);
      }
    }
  }

  try {
    const applied = migrate(db);
    if (applied.length) logger.info('Migrations applied:', applied.join(', '));
  } catch (err) {
    closeDatabase(db);
    db = null;
    if (err.code === 'DB_NEWER') return setStatus('db_newer', err.message);
    logger.error('Migration failed', err);
    return setStatus('migration_failed', 'Updating the data file failed. No changes were made.', [
      err.message,
    ]);
  }

  setStatus('ok');
}

async function startup(appPaths) {
  paths = appPaths;
  backup.cleanupTemp(paths.backupsDir);

  if (!fs.existsSync(paths.dbFile) && backup.listBackups(paths.backupsDir).length > 0) {
    return setStatus(
      'missing_db',
      'The data file (app.db) is missing, but backups were found. Restore a backup, or start with empty data.',
    );
  }
  await openAndPrepare({ backupReason: 'start' });
  return status;
}

function getStatus() {
  return status;
}

function getDb() {
  if (!db) throw new AppError('The database is not open.', 'DB_UNAVAILABLE');
  return db;
}

function isOpen() {
  return Boolean(db && db.open);
}

async function createManualBackup() {
  return backup.createBackup(getDb(), paths.backupsDir, 'manual');
}

async function exportBackupTo(destFile) {
  await backup.backupTo(getDb(), destFile);
}

/** Restores a backup from data/backups. The current data is always backed up first. */
async function restore(fileName) {
  const src = backup.resolveBackupFile(paths.backupsDir, fileName);

  if (isOpen()) {
    await backup.createBackup(db, paths.backupsDir, 'prerestore');
    closeDatabase(db);
    db = null;
  } else if (fs.existsSync(paths.dbFile)) {
    const saved = backup.saveRawCopy(paths.dbFile, paths.backupsDir, 'damaged');
    logger.warn('Saved a copy of the damaged data file as', saved);
  }

  backup.replaceDbFile(src, paths.dbFile);
  logger.info('Restored backup', fileName);
  await openAndPrepare({ backupReason: null });
  return status;
}

/** Only allowed when app.db is missing: creates a fresh, empty database. */
async function startFresh() {
  if (status.state !== 'missing_db') {
    throw new AppError('Starting fresh is only possible when the data file is missing.');
  }
  await openAndPrepare({ backupReason: null });
  return status;
}

/** Normal quit: closing backup, then close. */
async function shutdown() {
  if (!isOpen()) return;
  try {
    await backup.createBackup(db, paths.backupsDir, 'close');
  } catch (err) {
    logger.error('Closing backup failed', err);
  }
  closeNow();
}

/** Immediate close (Windows logoff/shutdown); no time for a backup. */
function closeNow() {
  if (!isOpen()) return;
  try {
    closeDatabase(db);
    logger.info('Database closed');
  } catch (err) {
    logger.error('Closing database failed', err);
  }
  db = null;
}

module.exports = {
  startup,
  getStatus,
  getDb,
  isOpen,
  createManualBackup,
  exportBackupTo,
  restore,
  startFresh,
  shutdown,
  closeNow,
  listBackups: () => backup.listBackups(paths.backupsDir),
};
