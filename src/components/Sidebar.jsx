import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../navigation';

export default function Sidebar() {
  return (
    <nav className="flex w-56 shrink-0 flex-col bg-slate-900 text-slate-300">
      <div className="px-4 py-4 text-lg font-semibold text-white">StockApp</div>
      <ul className="flex-1 space-y-0.5 px-2">
        {NAV_ITEMS.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) =>
                `flex items-center justify-between rounded-md px-3 py-2 ${
                  isActive ? 'bg-indigo-600 text-white' : 'hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <span>{item.label}</span>
              <kbd className="font-sans text-xs opacity-60">Alt+{item.key}</kbd>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
