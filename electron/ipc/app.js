'use strict';

const fs = require('fs');
const { app, clipboard, shell } = require('electron');
const dbm = require('../db');
const { currentVersion } = require('../db/migrate');

function register(handle, { paths }) {
  handle('app:startupStatus', () => dbm.getStatus());
  handle('app:startupProgress', () => dbm.getProgress(), { waitForDb: false });

  handle('app:info', () => {
    const backups = dbm.listBackups();
    return {
      version: app.getVersion(),
      electron_version: process.versions.electron,
      is_packaged: app.isPackaged,
      // For display only. Never persist this: the drive letter changes between PCs.
      data_dir: paths.dataDir,
      db_state: dbm.getStatus().state,
      schema_version: dbm.isOpen() ? currentVersion(dbm.getDb()) : null,
      db_size_bytes: fs.existsSync(paths.dbFile) ? fs.statSync(paths.dbFile).size : 0,
      backup_count: backups.length,
      last_backup: backups[0] || null,
    };
  });

  handle('app:openDataFolder', async () => {
    const error = await shell.openPath(paths.dataDir);
    if (error) throw new Error(error);
  });

  handle('app:startFresh', () => dbm.startFresh());

  // The renderer has no clipboard permission (all permission requests are denied).
  handle(
    'app:copyText',
    ({ text }) => {
      clipboard.writeText(String(text ?? '').slice(0, 10000));
    },
    { waitForDb: false },
  );
}

module.exports = { register };
