import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);
let nextId = 1;

const STYLES = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  error: 'border-red-300 bg-red-50 text-red-900',
  info: 'border-slate-300 bg-white text-slate-800',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (type, message) => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-3), { id, type, message }]);
      setTimeout(() => dismiss(id), type === 'error' ? 7000 : 3500);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (m) => show('success', m),
      error: (m) => show('error', m instanceof Error ? m.message : m),
      info: (m) => show('info', m),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto rounded-md border px-4 py-3 shadow-md ${STYLES[t.type]}`}
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
