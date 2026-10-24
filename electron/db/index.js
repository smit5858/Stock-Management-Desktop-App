'use strict';

const fs = require('fs');
const { openDatabase, integrityCheck, closeDatabase } = require('./connection');
const { pendingMigrations, applyMigration, migrationLabel } = require('./migrate');
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
 *   'schema_mismatch'   created by a different (development) schema of the same version
 *   'migration_failed'  upgrade failed (the migration that failed was rolled back)
 */
let db = null;
let paths = null;
let migrationsDir; // undefined = the bundled migrations (tests may point elsewhere)
let status = { state: 'starting' };

// Startup stage for the loader screen: opening → checking → backup → migrating → ready.
let progress = 'opening';
let progressListener = null;

/** Sets the stage and yields once so the event reaches the window before sync work starts. */
function setProgress(stage) {
  progress = stage;
  if (progressListener) progressListener(stage);
  return new Promise((resolve) => setImmediate(resolve));
}

function setStatus(state, message = '', details = []) {
  status = { state, message, details };
  if (state !== 'ok') logger.warn(`Database status: ${state}`, message, details);
  return status;
}

/** Opens app.db, checks it, backs it up and migrates it. Assumes no connection is open. */
async function openAndPrepare({ backupReason }) {
  const existed = fs.existsSync(paths.dbFile);

  await setProgress('opening');
  try {
    db = openDatabase(paths.dbFile);
  } catch (err) {
    db = null;
    logger.error('Opening database failed', err);
    return setStatus('open_failed', 'It may be damaged, or it is not a Pragati Car data file.', [
      err.message,
    ]);
  }

  if (existed) {
    await setProgress('checking');
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
      await setProgress('backup');
      try {
        await backup.createBackup(db, paths.backupsDir, backupReason);
      } catch (err) {
        // Keep working, but make sure it is visible in the log.
        logger.error('Automatic backup failed', err);
      }
    }
  }

  await setProgress('migrating');
  let preBackup = null;
  try {
    const pending = pendingMigrations(db, migrationsDir);
    for (const m of pending) {
      // Existing data: a named, verified backup right before each migration.
      if (existed) {
        preBackup = await backup.createPreMigrationBackup(db, paths.backupsDir, m.version);
        logger.info(`Backup before ${migrationLabel(m)}:`, preBackup.file_name);
      }
      applyMigration(db, m);
      logger.info('Migration applied:', migrationLabel(m));
      preBackup = null;
    }
  } catch (err) {
    closeDatabase(db);
    db = null;
    if (preBackup) {
      // The failed migration was rolled back already; restoring the backup taken just before
      // it guarantees the file is exactly as it was.
      try {
        backup.replaceDbFile(preBackup.file, paths.dbFile);
        logger.warn('Migration failed; restored', preBackup.file_name);
      } catch (restoreErr) {
        logger.error('Restoring the pre-migration backup failed', restoreErr);
      }
    }
    if (err.code === 'DB_NEWER') return setStatus('db_newer', err.message);
    if (err.code === 'SCHEMA_MISMATCH') {
      return setStatus(
        'schema_mismatch',
        `${err.message} Close the app, then rename or delete the "data" folder to start fresh.`,
      );
    }
    logger.error('Migration failed', err);
    return setStatus('migration_failed', 'Updating the data file failed. No changes were made.', [
      err.message,
    ]);
  }

  setStatus('ok');
}

async function startup(appPaths, { migrationsDir: dir } = {}) {
  paths = appPaths;
  migrationsDir = dir;
  backup.cleanupTemp(paths.backupsDir);

  if (!fs.existsSync(paths.dbFile) && backup.listBackups(paths.backupsDir).length > 0) {
    return setStatus(
      'missing_db',
      'The data file (app.db) is missing, but backups were found. Restore a backup, or start with empty data.',
    );
  }
  await openAndPrepare({ backupReason: 'start' });
  await setProgress('ready');
  return status;
}

function getProgress() {
  return progress;
}

function onProgress(listener) {
  progressListener = listener;
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
  getProgress,
  onProgress,
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
