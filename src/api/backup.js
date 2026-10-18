import { invoke } from './client';

export const backupApi = {
  list: () => invoke('backup:list'),
  create: () => invoke('backup:create'),
  restore: (fileName) => invoke('backup:restore', { fileName }),
  exportTo: () => invoke('backup:exportTo'),
};
