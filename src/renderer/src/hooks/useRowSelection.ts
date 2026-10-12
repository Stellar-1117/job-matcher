import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

/**
 * Spreadsheet-style row selection over an ordered list of ids:
 *  - click a checkbox to toggle it
 *  - press on a checkbox and drag over other rows to select (or unselect) the whole run
 *  - Shift-click to select the range from the last clicked row
 *  - Ctrl/Cmd-click anywhere on a row (outside links/buttons) to toggle it
 */
export function useRowSelection(orderedIds: number[]) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ mode: boolean; last: number } | null>(null);
  const order = useRef(orderedIds);
  order.current = orderedIds;

  useEffect(() => {
    const end = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove('select-none');
    };
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
    };
  }, []);

  const applyRange = useCallback((from: number, to: number, on: boolean) => {
    const ids = order.current;
    let a = ids.indexOf(from);
    let b = ids.indexOf(to);
    if (a < 0) a = b;
    if (b < 0) return;
    if (a > b) [a, b] = [b, a];
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids.slice(a, b + 1)) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  }, []);

  const toggle = useCallback((id: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  /** Props for the checkbox cell (the drag handle). */
  const handleProps = (id: number) => ({
    onMouseDown: (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && anchor.current != null) {
        applyRange(anchor.current, id, true);
        return;
      }
      const mode = !selected.has(id);
      applyRange(id, id, mode);
      anchor.current = id;
      drag.current = { mode, last: id };
      document.body.classList.add('select-none');
    },
    title: 'Click to select · drag to select several · Shift-click for a range',
    style: { cursor: 'pointer' } as const,
  });

  /** Props for the whole row: continues a drag, and Ctrl/Cmd-click toggles. */
  const rowProps = (id: number) => ({
    onMouseEnter: () => {
      if (!drag.current) return;
      // Fill any rows skipped by a fast mouse movement.
      applyRange(drag.current.last, id, drag.current.mode);
      drag.current.last = id;
    },
    onClick: (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.target as HTMLElement).closest('a,button,input,select,textarea')) return;
      e.preventDefault();
      toggle(id);
      anchor.current = id;
    },
  });

  const setMany = useCallback((ids: number[], on: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(order.current)), []);
  const isSelected = useCallback((id: number) => selected.has(id), [selected]);
  const selectedIds = useMemo(() => [...selected], [selected]);

  return { selected, selectedIds, isSelected, handleProps, rowProps, setMany, clear, selectAll, toggle };
}
