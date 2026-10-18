import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Main-process code is CommonJS; load it with Node's own require (not Vite's transform).
export const require = createRequire(import.meta.url);

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stockapp-test-'));
}

export function testPaths(baseDir = tempDir()) {
  const { resolvePaths, ensureDataDirs } = require('../electron/paths.js');
  const paths = resolvePaths({ isPackaged: false, execPath: '', env: {}, devRoot: baseDir });
  ensureDataDirs(paths);
  return paths;
}
