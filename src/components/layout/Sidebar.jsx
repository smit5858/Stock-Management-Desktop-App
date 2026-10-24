import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV_ITEMS, navItemFor } from '../../navigation';
import { usePrefs } from '../Prefs';
import { useBranding } from '../Branding';
import { Tooltip } from '../Feedback';

const EXPANDED = 248;
const COLLAPSED = 72;
const SPRING = { type: 'spring', stiffness: 420, damping: 40 };

function Label({ show, children, className = '' }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.span
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4, transition: { duration: 0.08 } }}
          transition={{ duration: 0.15, delay: 0.05 }}
          className={`truncate ${className}`}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export default function Sidebar() {
  const { prefs, setPref } = usePrefs();
  const { logoUrl, businessName } = useBranding();
  const { pathname } = useLocation();
  const collapsed = prefs.sidebarCollapsed;
  const activePath = navItemFor(pathname).path;

  return (
    <motion.nav
      initial={false}
      animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
      transition={SPRING}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
    >
      <div className="flex h-16 items-center gap-3 px-4">
        <motion.img
          src={logoUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-xl object-contain"
          whileHover={{ rotate: -4, scale: 1.05 }}
        />
        <Label show={!collapsed} className="text-base font-bold tracking-tight">
          {businessName}
        </Label>
      </div>

      <ul className="flex-1 space-y-1 px-3 py-2">
        {NAV_ITEMS.map((item) => {
          const active = item.path === activePath;
          const Icon = item.icon;
          return (
            <li key={item.path}>
              <Tooltip label={`${item.label}  ·  Alt+${item.key}`} show={collapsed}>
                <NavLink
                  to={item.path}
                  className={`relative flex h-10 items-center gap-3 rounded-lg px-3 transition-colors ${
                    active ? 'text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      transition={SPRING}
                      className="absolute inset-0 rounded-lg bg-primary-soft"
                    />
                  )}
                  <Icon size={19} strokeWidth={active ? 2.3 : 1.9} className="relative shrink-0" />
                  <Label show={!collapsed} className="relative flex-1 font-medium">
                    {item.label}
                  </Label>
                  <Label show={!collapsed} className="relative text-[11px] opacity-60">
                    Alt+{item.key}
                  </Label>
                </NavLink>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-border p-3">
        <Tooltip label="Expand sidebar  ·  Ctrl+B" show={collapsed}>
          <button
            type="button"
            onClick={() => setPref('sidebarCollapsed', !collapsed)}
            className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {collapsed ? (
              <PanelLeftOpen size={19} className="shrink-0" />
            ) : (
              <PanelLeftClose size={19} className="shrink-0" />
            )}
            <Label show={!collapsed} className="flex-1 text-left">
              Collapse
            </Label>
            <Label show={!collapsed} className="text-[11px] opacity-60">
              Ctrl+B
            </Label>
          </button>
        </Tooltip>
      </div>
    </motion.nav>
  );
}
