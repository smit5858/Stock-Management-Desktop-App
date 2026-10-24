import { useEffect, useRef, useState } from 'react';

/**
 * Renders only the visible rows of a long, fixed-row-height list. The container scrolls;
 * `selected` is kept in view (keyboard navigation). `renderRow(item, index)` returns a row.
 */
export default function VirtualList({
  items,
  rowHeight,
  renderRow,
  selected = -1,
  overscan = 8,
  className = '',
  getKey = (item, i) => item.id ?? i,
}) {
  const ref = useRef(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || selected < 0) return;
    const top = selected * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rowHeight - el.clientHeight;
    }
  }, [selected, rowHeight]);

  const first = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const last = Math.min(items.length, Math.ceil((view.top + view.height) / rowHeight) + overscan);

  return (
    <div
      ref={ref}
      className={`overflow-auto ${className}`}
      onScroll={(e) =>
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
      }
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(first, last).map((item, k) => {
          const i = first + k;
          return (
            <div
              key={getKey(item, i)}
              style={{
                position: 'absolute',
                top: i * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight,
              }}
            >
              {renderRow(item, i)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
