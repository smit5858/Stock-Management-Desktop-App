'use strict';

const fs = require('fs');
const path = require('path');
const { quickCheckFile } = require('./connection');
const { AppError } = require('../errors');

const KEEP = 30;
// app_YYYY-MM-DD_HH-mm-ss_<reason>.db  (seconds + reason so a start and close backup in
// the same minute never overwrite each other)
const BACKUP_RE = /^app_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_([a-z]+)\.db$/;
const REASONS = ['start', 'close', 'manual', 'prerestore', 'damaged'];
// pre-migration_005_YYYY-MM-DD_HH-mm-ss.db: taken right before a schema upgrade. Never rotated.
const PRE_MIGRATION_RE = /^pre-migration_(\d{3})_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.db$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function backupFileName(reason, d = new Date()) {
  if (!REASONS.includes(reason)) throw new Error(`Unknown backup reason: ${reason}`);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `app_${date}_${time}_${reason}.db`;
}

function stamp(d) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function preMigrationFileName(version, d = new Date()) {
  return `pre-migration_${String(version).padStart(3, '0')}_${stamp(d)}.db`;
}

function isBackupName(fileName) {
  return BACKUP_RE.test(fileName) || PRE_MIGRATION_RE.test(fileName);
}

function describe(dir, fileName) {
  const stat = fs.statSync(path.join(dir, fileName));
  const m = BACKUP_RE.exec(fileName);
  if (m) {
    return {
      file_name: fileName,
      created_at: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`,
      reason: m[5],
      size_bytes: stat.size,
    };
  }
  const pm = PRE_MIGRATION_RE.exec(fileName);
  if (!pm) return null;
  return {
    file_name: fileName,
    created_at: `${pm[2]} ${pm[3]}:${pm[4]}:${pm[5]}`,
    reason: 'premigration',
    migration: pm[1],
    size_bytes: stat.size,
  };
}

/** Newest first. */
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBackupName)
    .map((name) => describe(dir, name))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function rotate(dir, keep = KEEP) {
  const all = listBackups(dir).filter((b) => b.reason !== 'premigration');
  for (const old of all.slice(keep)) fs.unlinkSync(path.join(dir, old.file_name));
}

/** Removes half-written backups left by an interrupted run. */
function cleanupTemp(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) fs.unlinkSync(path.join(dir, name));
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Online backup of an open DB to `destFile`. Written to a .tmp file first and checked,
 * then renamed, so a half-written backup never looks like a good one.
 */
async function backupTo(db, destFile) {
  const tmp = `${destFile}.tmp`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  await db.backup(tmp);
  fsyncFile(tmp);
  if (!quickCheckFile(tmp)) {
    fs.unlinkSync(tmp);
    throw new Error(`Backup verification failed for ${path.basename(destFile)}`);
  }
  fs.renameSync(tmp, destFile);
}

/** Backup taken right before migration `version` runs (kept; not part of the 30 rotated). */
async function createPreMigrationBackup(db, dir, version) {
  const fileName = preMigrationFileName(version);
  await backupTo(db, path.join(dir, fileName));
  return { ...describe(dir, fileName), file: path.join(dir, fileName) };
}

async function createBackup(db, dir, reason) {
  const fileName = backupFileName(reason);
  await backupTo(db, path.join(dir, fileName));
  rotate(dir);
  return describe(dir, fileName);
}

/** Copies a (possibly damaged) DB file as-is into the backups folder. */
function saveRawCopy(dbFile, dir, reason) {
  const fileName = backupFileName(reason);
  fs.copyFileSync(dbFile, path.join(dir, fileName));
  return fileName;
}

/** Validates a backup file name from the renderer (no paths, must exist). */
function resolveBackupFile(dir, fileName) {
  if (typeof fileName !== 'string' || !isBackupName(fileName)) {
    throw new AppError('Invalid backup file name.', 'VALIDATION');
  }
  const file = path.join(dir, fileName);
  if (!fs.existsSync(file)) throw new AppError('That backup file no longer exists.', 'NOT_FOUND');
  return file;
}

/**
 * Replaces the (closed) DB file with a backup. Copies to .tmp, fsyncs, checks it, and
 * removes any stale rollback journal (it belongs to the old file and would corrupt the
 * restored one) before the final rename.
 */
function replaceDbFile(srcFile, dbFile) {
  if (!quickCheckFile(srcFile)) {
    throw new AppError('This backup file is damaged and cannot be restored.', 'BACKUP_DAMAGED');
  }
  const tmp = `${dbFile}.restore.tmp`;
  fs.copyFileSync(srcFile, tmp);
  fsyncFile(tmp);
  if (!quickCheckFile(tmp)) {
    fs.unlinkSync(tmp);
    throw new AppError('Copying the backup failed. Please try again.', 'RESTORE_FAILED');
  }
  const journal = `${dbFile}-journal`;
  if (fs.existsSync(journal)) fs.unlinkSync(journal);
  fs.renameSync(tmp, dbFile);
}

module.exports = {
  KEEP,
  BACKUP_RE,
  PRE_MIGRATION_RE,
  backupFileName,
  preMigrationFileName,
  createPreMigrationBackup,
  listBackups,
  rotate,
  cleanupTemp,
  backupTo,
  createBackup,
  saveRawCopy,
  resolveBackupFile,
  replaceDbFile,
};
