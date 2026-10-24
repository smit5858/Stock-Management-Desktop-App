'use strict';

const dbm = require('../db');
const settings = require('../services/settings');

function register(handle) {
  handle('settings:get', () => settings.getSettings(dbm.getDb()));
  handle('settings:update', ({ values }) => settings.updateSettings(dbm.getDb(), values));

  handle('sequences:list', () => settings.listSequences(dbm.getDb()));
  handle('sequences:update', (payload) => settings.updateSequencePrefix(dbm.getDb(), payload));

  handle('gstRates:list', () => settings.listGstRates(dbm.getDb()));
  handle('gstRates:create', (payload) => settings.addGstRate(dbm.getDb(), payload));
  handle('gstRates:delete', (payload) => settings.removeGstRate(dbm.getDb(), payload));
}

module.exports = { register };
