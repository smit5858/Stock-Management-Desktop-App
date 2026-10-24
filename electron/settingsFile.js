'use strict';

const fs = require('fs');
const logger = require('./logger');

// Machine/UI preferences only. Business settings live in the DB so they are backed up.
const DEFAULTS = {
  window: { width: 1280, height: 760, maximized: true },
  ui: {
    theme: 'system', // light | dark | system
    sidebarCollapsed: false,
    reduceMotion: false,
    startupSound: true,
    soundVolume: 0.6, // 0..1
  },
};

const UI_VALIDATORS = {
  theme: (v) => ['light', 'dark', 'system'].includes(v),
  sidebarCollapsed: (v) => typeof v === 'boolean',
  reduceMotion: (v) => typeof v === 'boolean',
  startupSound: (v) => typeof v === 'boolean',
  soundVolume: (v) => typeof v === 'number' && v >= 0 && v <= 1,
};

function read(file) {
  const defaults = structuredClone(DEFAULTS);
  if (!fs.existsSync(file)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      window: { ...defaults.window, ...parsed.window },
      ui: { ...defaults.ui, ...sanitizeUi(parsed.ui) },
    };
  } catch (err) {
    logger.warn('settings.json unreadable, using defaults', err);
    try {
      fs.copyFileSync(file, `${file}.bad`);
    } catch {
      // Best effort only.
    }
    return defaults;
  }
}

/** Keeps only known keys with valid values. */
function sanitizeUi(ui) {
  const clean = {};
  if (!ui || typeof ui !== 'object') return clean;
  for (const [key, valid] of Object.entries(UI_VALIDATORS)) {
    if (key in ui && valid(ui[key])) clean[key] = ui[key];
  }
  return clean;
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

/** Merges valid UI prefs into settings.json and returns the new UI prefs. */
function updateUi(file, partial) {
  const prefs = read(file);
  prefs.ui = { ...prefs.ui, ...sanitizeUi(partial) };
  write(file, prefs);
  return prefs.ui;
}

module.exports = { read, write, updateUi, DEFAULTS };
