import {
  BarChart3,
  LayoutDashboard,
  Package,
  ReceiptText,
  Settings,
  ShieldCheck,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';

// Sidebar entries. `key` is the Alt+<key> shortcut; `phase` = placeholder until that phase.
export const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', key: '1', icon: LayoutDashboard },
  { path: '/billing', label: 'Billing', key: '2', icon: ReceiptText, also: ['/sales'] },
  { path: '/products', label: 'Products & Stock', key: '3', icon: Package },
  { path: '/purchases', label: 'Purchases', key: '4', icon: Truck },
  { path: '/parties', label: 'Customers & Suppliers', key: '5', icon: Users },
  { path: '/warranty', label: 'Warranty', key: '6', icon: ShieldCheck },
  { path: '/accounts', label: 'Accounts', key: '7', icon: Wallet, phase: 6 },
  { path: '/reports', label: 'Reports', key: '8', icon: BarChart3, phase: 7 },
  { path: '/settings', label: 'Settings', key: '9', icon: Settings },
];

export function navItemFor(pathname) {
  return (
    NAV_ITEMS.find(
      (i) => i.path !== '/' && [i.path, ...(i.also || [])].some((p) => pathname.startsWith(p)),
    ) || NAV_ITEMS[0]
  );
}
