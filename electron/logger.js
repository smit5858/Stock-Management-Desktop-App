'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
let logsDir = null;

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function init(dir) {
  logsDir = dir;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^app_\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch {
    // Log rotation must never stop the app from starting.
  }
}

function format(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, parts) {
  const line = `${stamp()} [${level}] ${parts.map(format).join(' ')}\n`;
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
  if (!logsDir) return;
  try {
    const file = path.join(logsDir, `app_${stamp().slice(0, 10)}.log`);
    fs.appendFileSync(file, line);
  } catch {
    // Disk full or USB removed: nothing more we can do here.
  }
}

module.exports = {
  init,
  info: (...parts) => write('INFO', parts),
  warn: (...parts) => write('WARN', parts),
  error: (...parts) => write('ERROR', parts),
};
