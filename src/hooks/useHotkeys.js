import { useEffect, useRef } from 'react';

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Registers global keyboard shortcuts. `bindings` maps a combo like 'Alt+1', 'Ctrl+K', 'N',
 * '/', 'Enter' or 'F3' to a handler. Combos without Ctrl/Alt are ignored while typing in a
 * field, except function keys (F1–F12), which never type anything.
 * Pass `enabled: false` to pause them (e.g. while a drawer is open).
 */
export function useHotkeys(bindings, { enabled = true } = {}) {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    function onKeyDown(event) {
      if (event.defaultPrevented) return;
      const parts = [];
      if (event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey && event.key.length > 1) parts.push('Shift');
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      const combo = parts.join('+');
      const handler = ref.current[combo];
      if (!handler) return;
      const fnKey = /^F\d{1,2}$/.test(event.key);
      if (!event.ctrlKey && !event.altKey && !fnKey && isTyping(event.target)) return;
      event.preventDefault();
      handler(event);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
