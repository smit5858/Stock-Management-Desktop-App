'use strict';

const path = require('path');
const { app, dialog } = require('electron');
const dbm = require('../db');
const { backupFileName } = require('../db/backup');
const { AppError } = require('../errors');

function register(handle, { getWindow }) {
  handle('backup:list', () => dbm.listBackups());

  handle('backup:create', () => dbm.createManualBackup());

  handle('backup:restore', ({ fileName }) => dbm.restore(fileName));

  handle('backup:exportTo', async () => {
    if (!dbm.isOpen()) throw new AppError('The database is not open.', 'DB_UNAVAILABLE');
    const defaultName = backupFileName('manual').replace(/^app_/, 'StockApp_backup_');
    const result = await dialog.showSaveDialog(getWindow(), {
      title: 'Save a copy of your data',
      defaultPath: path.join(app.getPath('desktop'), defaultName),
      filters: [{ name: 'StockApp backup', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await dbm.exportBackupTo(result.filePath);
    return { saved: true, file_path: result.filePath };
  });
}

module.exports = { register };
