import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { appApi } from '../api/app';

const AppInfoContext = createContext({ info: null, refresh: () => {} });

/** App/DB/backup info shared by the status bar and dashboard. Call refresh() after changes. */
export function AppInfoProvider({ children }) {
  const [info, setInfo] = useState(null);

  const refresh = useCallback(() => {
    appApi
      .info()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return <AppInfoContext.Provider value={{ info, refresh }}>{children}</AppInfoContext.Provider>;
}

export function useAppInfo() {
  return useContext(AppInfoContext);
}
