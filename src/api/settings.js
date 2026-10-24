import { invoke } from './client';

export const settingsApi = {
  get: () => invoke('settings:get'),
  update: (values) => invoke('settings:update', { values }),
  sequences: () => invoke('sequences:list'),
  updateSequence: (name, prefix) => invoke('sequences:update', { name, prefix }),
  gstRates: () => invoke('gstRates:list'),
  addGstRate: (rate_bp) => invoke('gstRates:create', { rate_bp }),
  removeGstRate: (id) => invoke('gstRates:delete', { id }),
};

export const prefsApi = {
  get: () => invoke('prefs:get'),
  set: (partial) => invoke('prefs:set', partial),
};

export const brandingApi = {
  get: () => invoke('branding:get'),
  pickLogo: () => invoke('branding:pickLogo'),
  resetLogo: () => invoke('branding:resetLogo'),
  pickSound: () => invoke('branding:pickSound'),
  resetSound: () => invoke('branding:resetSound'),
  setWindowIcon: (dataUrl) => invoke('branding:setWindowIcon', { dataUrl }),
};
