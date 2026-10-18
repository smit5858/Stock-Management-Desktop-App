'use strict';

const fs = require('fs');
const logger = require('./logger');

// Machine/UI preferences only. Business settings live in the DB so they are backed up.
const DEFAULTS = {
  window: { width: 1280, height: 760, maximized: true },
};

function read(file) {
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...structuredClone(DEFAULTS), ...parsed };
  } catch (err) {
    logger.warn('settings.json unreadable, using defaults', err);
    try {
      fs.copyFileSync(file, `${file}.bad`);
    } catch {
      // Best effort only.
    }
    return structuredClone(DEFAULTS);
  }
}

/** Atomic write: temp file + fsync + rename, so a pulled USB never leaves half a file. */
function write(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

module.exports = { read, write, DEFAULTS };
