import { invoke } from './client';

export const appApi = {
  startupStatus: () => invoke('app:startupStatus'),
  info: () => invoke('app:info'),
  openDataFolder: () => invoke('app:openDataFolder'),
  startFresh: () => invoke('app:startFresh'),
};
