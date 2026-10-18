import { useEffect, useRef } from 'react';

/**
 * Registers global keyboard shortcuts. `bindings` maps a combo like 'Alt+1', 'F2' or
 * 'Ctrl+S' to a handler. The default browser action is prevented for matched combos.
 */
export function useHotkeys(bindings) {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });

  useEffect(() => {
    function onKeyDown(event) {
      const parts = [];
      if (event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      const handler = ref.current[parts.join('+')];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
