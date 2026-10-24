import { useId } from 'react';
import { motion } from 'framer-motion';

const INPUT =
  'h-9 w-full rounded-lg border border-border bg-surface px-3 text-fg placeholder:text-muted/70 transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60';

/** Label + control + error/hint. `children` receives the generated id. */
export function Field({ label, error, hint, required, className = '', children }) {
  const id = useId();
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger"> *</span>}
        </label>
      )}
      {children(id)}
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}

export function Input({ className = '', invalid, ...props }) {
  return (
    <input
      className={`${INPUT} ${invalid ? 'border-danger' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

/** Rupee amount typed as text (parsed to paise on save, never with floats). */
export function MoneyInput({ className = '', invalid, ...props }) {
  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
        ₹
      </span>
      <Input
        inputMode="decimal"
        className="pl-7 text-right tabular-nums"
        invalid={invalid}
        {...props}
      />
    </div>
  );
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={`${INPUT} pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...props }) {
  return <textarea className={`${INPUT} h-auto py-2 ${className}`} rows={3} {...props} />;
}

/** On/off switch. */
export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-1">
      <span>
        <span className="block font-medium">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-surface-3'
        } disabled:opacity-50`}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow ${
            checked ? 'right-0.5' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}

/** Segmented control with a sliding highlight. options: [{ value, label, icon }] */
export function Segmented({ value, onChange, options, layoutId }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`relative flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap ${
              active ? 'text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-md bg-surface shadow-sm"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon size={15} />}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
