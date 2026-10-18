import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import ClosingOverlay from './components/ClosingOverlay';
import { ToastProvider } from './components/Toast';
import { AppInfoProvider } from './components/AppInfo';
import { useHotkeys } from './hooks/useHotkeys';
import { NAV_ITEMS } from './navigation';
import { appApi } from './api/app';
import Dashboard from './pages/Dashboard';
import ComingSoon from './pages/ComingSoon';
import Recovery from './pages/Recovery';

function Shell() {
  const navigate = useNavigate();
  useHotkeys(
    Object.fromEntries(NAV_ITEMS.map((item) => [`Alt+${item.key}`, () => navigate(item.path)])),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            {NAV_ITEMS.filter((item) => item.phase).map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={<ComingSoon title={item.label} phase={item.phase} />}
              />
            ))}
          </Routes>
        </main>
      </div>
      <StatusBar />
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    appApi
      .startupStatus()
      .then(setStatus)
      .catch((err) => setStatus({ state: 'open_failed', message: err.message, details: [] }));
  }, []);

  let content;
  if (!status) {
    content = <div className="p-8 text-slate-500">Opening data…</div>;
  } else if (status.state !== 'ok') {
    // Reload so every screen starts from the freshly opened database.
    content = <Recovery status={status} onRecovered={() => window.location.reload()} />;
  } else {
    content = (
      <AppInfoProvider>
        <HashRouter>
          <Shell />
        </HashRouter>
      </AppInfoProvider>
    );
  }

  return (
    <ToastProvider>
      {content}
      <ClosingOverlay />
    </ToastProvider>
  );
}
