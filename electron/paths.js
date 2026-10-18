'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Works out where the app's data folder lives. Kept free of `electron` imports so it can be tested.
 * - portable target: PORTABLE_EXECUTABLE_DIR (execPath points into a temp extract folder)
 * - packaged `dir` target: folder of the .exe
 * - dev: repo root
 * Nothing returned here may ever be persisted: the drive letter changes between PCs.
 */
function resolvePaths({ isPackaged, execPath, env = {}, devRoot }) {
  let baseDir;
  if (env.PORTABLE_EXECUTABLE_DIR) baseDir = env.PORTABLE_EXECUTABLE_DIR;
  else if (isPackaged) baseDir = path.dirname(execPath);
  else baseDir = devRoot;

  const dataDir = path.join(baseDir, 'data');
  return {
    baseDir,
    dataDir,
    dbFile: path.join(dataDir, 'app.db'),
    settingsFile: path.join(dataDir, 'settings.json'),
    backupsDir: path.join(dataDir, 'backups'),
    exportsDir: path.join(dataDir, 'exports'),
    logsDir: path.join(dataDir, 'logs'),
    electronDir: path.join(dataDir, '.electron'),
  };
}

function ensureDataDirs(paths) {
  for (const dir of [
    paths.dataDir,
    paths.backupsDir,
    paths.exportsDir,
    paths.logsDir,
    paths.electronDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Throws if the data folder cannot be written (e.g. write-protected USB). */
function assertWritable(dir) {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
}

module.exports = { resolvePaths, ensureDataDirs, assertWritable };
