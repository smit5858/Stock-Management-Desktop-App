import { useCallback, useEffect, useState } from 'react';
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Sidebar from './components/layout/Sidebar';
import TopBar from './components/layout/TopBar';
import CommandPalette from './components/layout/CommandPalette';
import StatusBar from './components/StatusBar';
import ClosingOverlay from './components/ClosingOverlay';
import Loader from './components/loader/Loader';
import { ToastProvider } from './components/Toast';
import { AppInfoProvider } from './components/AppInfo';
import { PrefsProvider, usePrefs } from './components/Prefs';
import { BrandingProvider, useBranding } from './components/Branding';
import { useHotkeys } from './hooks/useHotkeys';
import { NAV_ITEMS } from './navigation';
import { appApi } from './api/app';
import { settingsApi } from './api/settings';
import Dashboard from './pages/Dashboard';
import Products from './pages/products/Products';
import Parties from './pages/parties/Parties';
import Purchases from './pages/purchases/Purchases';
import PurchaseEntry from './pages/purchases/PurchaseEntry';
import Billing from './pages/sales/Billing';
import Sales from './pages/sales/Sales';
import Warranty from './pages/warranty/Warranty';
import Settings from './pages/Settings';
import ComingSoon from './pages/ComingSoon';
import Recovery from './pages/Recovery';

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { prefs, setPref } = usePrefs();
  const { setBusinessName } = useBranding();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSeq, setPaletteSeq] = useState(0);
  const openPalette = () => {
    setPaletteSeq((n) => n + 1);
    setPaletteOpen(true);
  };

  useEffect(() => {
    settingsApi
      .get()
      .then((s) => s.business_name && setBusinessName(s.business_name))
      .catch(() => {});
  }, [setBusinessName]);

  useHotkeys({
    ...Object.fromEntries(NAV_ITEMS.map((item) => [`Alt+${item.key}`, () => navigate(item.path)])),
    'Ctrl+B': () => setPref('sidebarCollapsed', !prefs.sidebarCollapsed),
    'Ctrl+K': openPalette,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onSearch={openPalette} />
          <main className="min-h-0 flex-1 overflow-auto">
            {/* Enter-only page transition: navigation never waits for an exit animation. */}
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="min-h-full"
            >
              <Routes location={location}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/billing" element={<Billing />} />
                <Route path="/sales" element={<Sales />} />
                <Route path="/products" element={<Products />} />
                <Route path="/parties" element={<Parties />} />
                <Route path="/purchases" element={<Purchases />} />
                <Route path="/purchases/new" element={<PurchaseEntry key={location.search} />} />
                <Route path="/purchases/:id/edit" element={<PurchaseEntry />} />
                <Route path="/warranty" element={<Warranty />} />
                <Route path="/settings" element={<Settings />} />
                {NAV_ITEMS.filter((item) => item.phase).map((item) => (
                  <Route
                    key={item.path}
                    path={item.path}
                    element={<ComingSoon title={item.label} phase={item.phase} />}
                  />
                ))}
              </Routes>
            </motion.div>
          </main>
        </div>
      </div>
      <StatusBar />
      <CommandPalette key={paletteSeq} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function Root() {
  const [status, setStatus] = useState(null);
  const [loaderDone, setLoaderDone] = useState(false);
  const finishLoader = useCallback(() => setLoaderDone(true), []);

  useEffect(() => {
    appApi
      .startupStatus()
      .then(setStatus)
      .catch((err) => setStatus({ state: 'open_failed', message: err.message, details: [] }));
  }, []);

  let content = null;
  if (status && status.state !== 'ok') {
    // Reload so every screen starts from the freshly opened database.
    content = <Recovery status={status} onRecovered={() => window.location.reload()} />;
  } else if (status) {
    content = (
      <AppInfoProvider>
        <HashRouter>
          <Shell />
        </HashRouter>
      </AppInfoProvider>
    );
  }

  return (
    <>
      {content}
      <AnimatePresence>
        {!loaderDone && <Loader ready={Boolean(status)} onDone={finishLoader} />}
      </AnimatePresence>
      <ClosingOverlay />
    </>
  );
}

export default function App() {
  return (
    <PrefsProvider>
      <BrandingProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </BrandingProvider>
    </PrefsProvider>
  );
}
