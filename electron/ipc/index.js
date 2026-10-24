'use strict';

const { ipcMain } = require('electron');
const logger = require('../logger');
const { AppError } = require('../errors');

const GENERIC_ERROR = 'Something went wrong. The details were saved in the log file.';

/**
 * Wraps every handler: trusted sender check, wait for DB startup (unless
 * `waitForDb: false`), uniform { ok, data } / { ok: false, error } result, and logging.
 */
function createHandle({ ready, isTrustedUrl }) {
  return function handle(channel, fn, { waitForDb = true } = {}) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedUrl(event.senderFrame && event.senderFrame.url)) {
        logger.warn(`Blocked IPC ${channel} from untrusted sender`);
        return { ok: false, error: { message: 'Not allowed.', code: 'FORBIDDEN' } };
      }
      try {
        if (waitForDb) await ready;
        const data = await fn(payload == null ? {} : payload, event);
        return { ok: true, data: data === undefined ? null : data };
      } catch (err) {
        if (err instanceof AppError) {
          return { ok: false, error: { message: err.message, code: err.code, fields: err.fields } };
        }
        logger.error(`IPC ${channel} failed`, err);
        return { ok: false, error: { message: GENERIC_ERROR, code: 'INTERNAL' } };
      }
    });
  };
}

function registerIpc(ctx) {
  const handle = createHandle(ctx);
  for (const name of [
    'app',
    'backup',
    'prefs',
    'branding',
    'settings',
    'products',
    'serials',
    'parties',
    'purchases',
    'sales',
    'warranty',
  ]) {
    require(`./${name}`).register(handle, ctx);
  }
}

module.exports = { registerIpc };
