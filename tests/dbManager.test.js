import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { require, testPaths } from './helpers.js';

// The manager is a singleton; each test runs a full start → shutdown cycle.
const dbm = require('../electron/db/index.js');

afterEach(() => dbm.closeNow());

async function seedOnce(paths, businessName) {
  expect((await dbm.startup(paths)).state).toBe('ok');
  dbm
    .getDb()
    .prepare("UPDATE settings SET value = ? WHERE key = 'business_name'")
    .run(businessName);
  await dbm.shutdown(); // makes a 'close' backup
}

describe('db manager', () => {
  it('first run creates the DB without a start backup; close makes one', async () => {
    const paths = testPaths();
    expect((await dbm.startup(paths)).state).toBe('ok');
    expect(dbm.listBackups()).toHaveLength(0);
    await dbm.shutdown();
    expect(dbm.listBackups().map((b) => b.reason)).toEqual(['close']);
    expect(dbm.isOpen()).toBe(false);
  });

  it('asks the user when app.db is missing but backups exist, and can restore', async () => {
    const paths = testPaths();
    await seedOnce(paths, 'Pragati Traders');
    fs.unlinkSync(paths.dbFile);

    expect((await dbm.startup(paths)).state).toBe('missing_db');
    const [latest] = dbm.listBackups();
    expect((await dbm.restore(latest.file_name)).state).toBe('ok');
    const name = dbm
      .getDb()
      .prepare("SELECT value FROM settings WHERE key = 'business_name'")
      .pluck()
      .get();
    expect(name).toBe('Pragati Traders');
  });

  it('detects a damaged data file and restores, keeping a copy of the damaged file', async () => {
    const paths = testPaths();
    await seedOnce(paths, 'Shop A');
    fs.writeFileSync(paths.dbFile, 'corrupted'.repeat(1000));

    const status = await dbm.startup(paths);
    expect(['open_failed', 'integrity_failed']).toContain(status.state);
    expect(() => dbm.getDb()).toThrow(/not open/);

    const good = dbm.listBackups().find((b) => b.reason === 'close');
    expect((await dbm.restore(good.file_name)).state).toBe('ok');
    expect(dbm.listBackups().some((b) => b.reason === 'damaged')).toBe(true);
  });

  it('takes a prerestore backup when restoring over healthy data', async () => {
    const paths = testPaths();
    await seedOnce(paths, 'Old');
    expect((await dbm.startup(paths)).state).toBe('ok'); // also makes a 'start' backup
    const target = dbm.listBackups().find((b) => b.reason === 'close');
    await dbm.restore(target.file_name);
    expect(dbm.listBackups().some((b) => b.reason === 'prerestore')).toBe(true);
  });
});

describe('schema upgrades', () => {
  const { openDatabase } = require('../electron/db/connection.js');
  const { migrate, MIGRATIONS_DIR } = require('../electron/db/migrate.js');
  const path = require('node:path');
  const { tempDir } = require('./helpers.js');

  function copyMigrations(filter = () => true) {
    const dir = tempDir();
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter(filter)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    }
    return dir;
  }

  function v4Database(paths) {
    const db = openDatabase(paths.dbFile);
    migrate(
      db,
      copyMigrations((f) => f < '005'),
    );
    db.prepare("UPDATE settings SET value = 'Before 005' WHERE key = 'business_name'").run();
    db.close();
  }

  it('takes a pre-migration backup before upgrading existing data', async () => {
    const paths = testPaths();
    v4Database(paths);
    expect((await dbm.startup(paths)).state).toBe('ok');
    // One backup before each pending migration (005–007); the first is taken before 005.
    const pre = dbm
      .listBackups()
      .filter((b) => b.reason === 'premigration')
      .filter((b) => b.file_name.startsWith('pre-migration_005_'));
    expect(pre).toHaveLength(1);
    expect(pre[0].file_name).toMatch(/^pre-migration_005_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
    const copy = openDatabase(path.join(paths.backupsDir, pre[0].file_name));
    expect(copy.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(4);
    copy.close();
  });

  it('restores the pre-migration backup when an upgrade fails', async () => {
    const paths = testPaths();
    v4Database(paths);
    const dir = copyMigrations();
    fs.writeFileSync(path.join(dir, '008_broken.sql'), 'INSERT INTO no_such_table VALUES (1);');
    const status = await dbm.startup(paths, { migrationsDir: dir });
    expect(status.state).toBe('migration_failed');
    const db = openDatabase(paths.dbFile);
    // 005–007 succeeded, 008 failed: the file is exactly as it was before 008 ran.
    expect(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(7);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'business_name'").pluck().get()).toBe(
      'Before 005',
    );
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
    expect(dbm.listBackups().filter((b) => b.reason === 'premigration')).toHaveLength(4);
  });
});
