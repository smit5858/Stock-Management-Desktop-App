import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { require } from './helpers.js';

const { resolvePaths } = require('../electron/paths.js');

describe('resolvePaths', () => {
  it('uses the exe folder when packaged', () => {
    const p = resolvePaths({ isPackaged: true, execPath: 'F:\\StockApp\\StockApp.exe', env: {} });
    expect(p.dataDir).toBe(path.join('F:\\StockApp', 'data'));
    expect(p.dbFile).toBe(path.join('F:\\StockApp', 'data', 'app.db'));
  });

  it('prefers PORTABLE_EXECUTABLE_DIR over execPath', () => {
    const p = resolvePaths({
      isPackaged: true,
      execPath: 'C:\\Users\\x\\AppData\\Local\\Temp\\abc\\StockApp.exe',
      env: { PORTABLE_EXECUTABLE_DIR: 'G:\\StockApp' },
    });
    expect(p.dataDir).toBe(path.join('G:\\StockApp', 'data'));
  });

  it('uses the repo root in dev', () => {
    const p = resolvePaths({ isPackaged: false, execPath: 'x', env: {}, devRoot: 'D:\\repo' });
    expect(p.backupsDir).toBe(path.join('D:\\repo', 'data', 'backups'));
  });
});
