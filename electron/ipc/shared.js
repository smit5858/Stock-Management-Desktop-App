'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataFiles = require('../dataFiles');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

/** Who did it: the computer's name until users / PIN arrive (Phase 8). */
function actor() {
  try {
    return os.hostname() || 'This computer';
  } catch {
    return 'This computer';
  }
}

/** The logo as a data URL (custom logo, else the app icon), so prints are self-contained. */
function logoDataUrl(paths) {
  try {
    const custom = dataFiles.getBranding(paths).logo;
    const file = custom
      ? path.join(paths.dataDir, custom.rel)
      : path.join(__dirname, '..', 'assets', 'icon.png');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!MIME[ext]) return null;
    return `data:${MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function fileSafe(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
}

module.exports = { actor, logoDataUrl, fileSafe };
