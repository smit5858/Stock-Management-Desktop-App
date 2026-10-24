import { invoke } from './client';

export const appApi = {
  startupStatus: () => invoke('app:startupStatus'),
  startupProgress: () => invoke('app:startupProgress'),
  info: () => invoke('app:info'),
  openDataFolder: () => invoke('app:openDataFolder'),
  startFresh: () => invoke('app:startFresh'),
  copyText: (text) => invoke('app:copyText', { text }),
};
