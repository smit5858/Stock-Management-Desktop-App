import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, ChevronDown, Search } from 'lucide-react';
import { AsYouType, getCountries, getCountryCallingCode } from 'libphonenumber-js/max';
import { useEscape } from './Overlay';
import { isPhone, normalizePhone, phoneDigitsAllowed } from '../utils/identity';

// Country names come from the bundled ICU data (no network).
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = getCountries()
  .map((code) => ({ code, name: regionNames.of(code) || code, dial: getCountryCallingCode(code) }))
  .sort((a, b) => (a.code === 'IN' ? -1 : b.code === 'IN' ? 1 : a.name.localeCompare(b.name)));

// Common short names people type in the search box.
const ALIASES = {
  GB: 'uk britain england',
  US: 'usa america',
  AE: 'uae dubai emirates',
  SA: 'ksa',
  NP: 'nepal',
  KR: 'korea',
};

/** Main country for a calling code ('1' → 'US', '44' → 'GB'). */
function countryForDial(dial) {
  const formatter = new AsYouType();
  formatter.input(`+${dial}`);
  return formatter.getCountry() || COUNTRIES.find((c) => c.dial === dial)?.code || null;
}

/**
 * Stored / typed value → { country, digits } (digits = national number without prefix).
 * Indian values are plain digits; other countries are '+<code><number>'.
 */
function split(value) {
  const v = String(value ?? '').trim();
  if (/^(\+|00)/.test(v)) {
    const n = normalizePhone(v);
    if (n.startsWith('+')) {
      const formatter = new AsYouType();
      formatter.input(n);
      const country = formatter.getCountry() || countryForDial(formatter.getCallingCode() || '');
      const dial = country ? getCountryCallingCode(country) : '';
      if (country) return { country, digits: n.slice(1 + dial.length) };
      return { country: 'IN', digits: '' };
    }
    return { country: 'IN', digits: n.slice(0, 10) };
  }
  return { country: 'IN', digits: normalizePhone(v).replace(/^0+/, '') };
}

function join(country, digits) {
  if (!digits) return '';
  return country === 'IN' ? digits : `+${getCountryCallingCode(country)}${digits}`;
}

function display(country, digits) {
  if (!digits) return '';
  if (country === 'IN')
    return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  // International pattern without the "+code" part ('50 123 4567'): national formats of some
  // countries need a trunk prefix the user does not type.
  const prefix = `+${getCountryCallingCode(country)}`;
  const text = new AsYouType().input(prefix + digits);
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : digits;
}

function CountryList({ anchor, current, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  useEscape(true, onClose);
  const q = query.trim().toLowerCase().replace(/^\+/, '');
  const list = useMemo(() => {
    if (!q) return COUNTRIES;
    // Rank: exact code / alias / dial code, then name or alias starting with q, then contains.
    const rank = (c) => {
      const name = c.name.toLowerCase();
      const aliases = (ALIASES[c.code] || '').split(' ');
      if (c.code.toLowerCase() === q || aliases.includes(q) || c.dial === q) return 0;
      if (name.startsWith(q) || aliases.some((a) => a.startsWith(q)) || c.dial.startsWith(q)) {
        return 1;
      }
      return name.includes(q) ? 2 : 3;
    };
    return COUNTRIES.map((c) => [rank(c), c])
      .filter(([r]) => r < 3)
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c);
  }, [q]);
  const active = Math.max(0, Math.min(index, list.length - 1));
  const below = window.innerHeight - anchor.bottom > 300;

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(Math.min(active + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (list[active]) onPick(list[active].code);
    } else if (e.key === 'Tab') {
      onClose();
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-90" onMouseDown={onClose} />
      <motion.div
        initial={{ opacity: 0, y: below ? -4 : 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.12 }}
        style={{
          left: anchor.left,
          ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
        }}
        className="fixed z-91 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={15} className="text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Country or code…"
            className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <ul className="max-h-64 overflow-auto p-1">
          {list.length === 0 && <li className="px-3 py-3 text-sm text-muted">No match</li>}
          {list.map((c, i) => (
            <li key={c.code}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(c.code)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                  i === active ? 'bg-primary-soft' : ''
                } ${c.code === current ? 'font-semibold text-primary' : ''}`}
              >
                <span className="w-7 shrink-0 rounded bg-surface-2 py-0.5 text-center text-[11px] font-semibold text-muted">
                  {c.code}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-muted tabular-nums">+{c.dial}</span>
              </button>
            </li>
          ))}
        </ul>
      </motion.div>
    </>,
    document.body,
  );
}

/**
 * Phone number with a country picker (India first). Formats as you type and refuses digits
 * that cannot belong to a number of that country (India: 10 digits). Pasting '+971 50…'
 * switches the country. `value` / `onChange(value)`: Indian numbers as plain digits, others as
 * '+<code><number>' (the stored form, see utils/identity.js).
 */
export default function PhoneInput({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  autoFocus,
  className = '',
}) {
  const [state, setState] = useState(() => ({ ...split(value), emitted: value ?? '' }));
  const [anchor, setAnchor] = useState(null);
  const inputRef = useRef(null);
  const buttonRef = useRef(null);

  // The parent replaced the value (e.g. form reset): take it over.
  let { country, digits } = state;
  if ((value ?? '') !== state.emitted) {
    ({ country, digits } = split(value));
    setState({ country, digits, emitted: value ?? '' });
  }

  function update(nextCountry, nextDigits) {
    const out = join(nextCountry, nextDigits);
    setState({ country: nextCountry, digits: nextDigits, emitted: out });
    onChange(out);
  }

  function onInput(e) {
    const text = e.target.value;
    if (/^\s*(\+|00)/.test(text)) {
      const next = split(text); // pasted an international number
      update(next.country, next.digits);
      return;
    }
    let next = text.replace(/\D/g, '');
    if (country === 'IN') {
      if (next.length > 10) next = normalizePhone(next); // pasted with 91 / 0 prefix
      next = next.replace(/^0+/, '');
    }
    if (!phoneDigitsAllowed(next, country, digits)) return; // too long: keep the old value
    update(country, next);
  }

  const dial = getCountryCallingCode(country);
  const valid = isPhone(join(country, digits));

  return (
    <div
      className={`flex h-9 w-full items-center rounded-lg border bg-surface transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 ${
        invalid ? 'border-danger' : 'border-border'
      } ${className}`}
    >
      <button
        ref={buttonRef}
        type="button"
        title="Country"
        onClick={() => setAnchor(buttonRef.current.getBoundingClientRect())}
        className="flex h-full shrink-0 items-center gap-1 rounded-l-lg border-r border-border px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
      >
        {country !== 'IN' && <span className="text-[11px] font-semibold">{country}</span>}
        <span className="tabular-nums">+{dial}</span>
        <ChevronDown size={13} />
      </button>
      <input
        ref={inputRef}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        value={display(country, digits)}
        onChange={onInput}
        onBlur={onBlur}
        placeholder={country === 'IN' ? '98765 43210' : ''}
        className="h-full min-w-0 flex-1 bg-transparent px-3 text-fg tabular-nums outline-none placeholder:text-muted/70"
      />
      {valid && <CheckCircle2 size={15} className="mr-2.5 shrink-0 text-success" />}
      {anchor && (
        <CountryList
          anchor={anchor}
          current={country}
          onClose={() => setAnchor(null)}
          onPick={(code) => {
            setAnchor(null);
            update(code, code === 'IN' ? digits.slice(0, 10) : digits);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
