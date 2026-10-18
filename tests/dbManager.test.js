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
