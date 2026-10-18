const VARIANTS = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
  secondary:
    'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
};

export default function Button({ variant = 'secondary', className = '', ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
