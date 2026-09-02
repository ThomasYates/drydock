import { useCallback, useEffect, useRef, useState } from 'react';

/* ── a number field with arrows that match the rest of the app ─────────── */

export function NumberField({ label, value, onChange, min = -1e6, max = 1e6, step = 1, suffix }) {
  const [text, setText] = useState(String(value));
  const dragging = useRef(null);
  useEffect(() => { setText(String(value)); }, [value]);

  const clamp = (n) => Math.max(min, Math.min(max, n));
  const commit = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) { setText(String(value)); return; }
    const next = clamp(Math.round(n * 100) / 100);
    setText(String(next));
    if (next !== value) onChange(next);
  };
  const nudge = (dir, big) => {
    const next = clamp(Number(value) + dir * step * (big ? 10 : 1));
    setText(String(next));
    onChange(next);
  };

  // dragging the label scrubs the value, the way most design tools do
  const scrub = (e) => {
    e.preventDefault();
    dragging.current = { x: e.clientX, from: Number(value) };
    const move = (ev) => {
      const delta = Math.round((ev.clientX - dragging.current.x) / 2) * step;
      const next = clamp(dragging.current.from + delta);
      setText(String(next));
      onChange(next);
    };
    const end = () => {
      dragging.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return (
    <div className="numfield">
      {label && (
        <span className="eyebrow scrub" onPointerDown={scrub} title="Drag to change">{label}</span>
      )}
      <div className="numbox">
        <input
          className="mono"
          value={text}
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1, e.shiftKey); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1, e.shiftKey); }
            else if (e.key === 'Escape') { setText(String(value)); e.currentTarget.blur(); }
          }}
        />
        {suffix && <span className="suffix mono">{suffix}</span>}
        <span className="steps">
          <button type="button" tabIndex={-1} aria-label={`Increase ${label || 'value'}`}
            onClick={(e) => nudge(1, e.shiftKey)}>
            <svg viewBox="0 0 10 6" width="9" height="5"><path d="M1 5 5 1l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" tabIndex={-1} aria-label={`Decrease ${label || 'value'}`}
            onClick={(e) => nudge(-1, e.shiftKey)}>
            <svg viewBox="0 0 10 6" width="9" height="5"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </span>
      </div>
    </div>
  );
}

/* ── text that actually saves ─────────────────────────────────────────── */

/**
 * An input that will not lose what you typed.
 *
 * Three things save it: a pause in typing, leaving the field, and the field
 * being removed. That last one is the awkward case — clicking away usually
 * tears down the whole panel, and a removed element never fires blur, so the
 * DOM node is captured up front rather than read back off the ref (React has
 * already nulled it by the time the cleanup runs).
 */
export function CommitInput({
  value, onCommit, multiline, allowEmpty = false, autosaveMs = 400, ...rest
}) {
  const ref = useRef(null);
  const saved = useRef(value ?? '');
  const timer = useRef(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // an edit from somewhere else resets what we consider saved, unless the
  // person is mid-sentence in this very field
  useEffect(() => {
    const el = ref.current;
    const next = value ?? '';
    if (next === saved.current) return;
    if (el && document.activeElement === el) return;
    saved.current = next;
    if (el) el.value = next;
  }, [value]);

  const flush = useRef(() => {});
  flush.current = (el) => {
    clearTimeout(timer.current);
    if (!el) return;
    const next = el.value;
    if (next === saved.current) return;
    if (!allowEmpty && !next.trim()) { el.value = saved.current; return; }
    saved.current = next;
    commit.current(next);
  };

  useEffect(() => {
    const el = ref.current;
    return () => { clearTimeout(timer.current); flush.current(el); };
  }, []);

  const shared = {
    ref,
    className: 'input',
    defaultValue: value ?? '',
    onChange: (e) => {
      const el = e.target;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flush.current(el), autosaveMs);
    },
    onBlur: (e) => flush.current(e.target),
    onKeyDown: (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        clearTimeout(timer.current);
        e.target.value = saved.current;
        e.target.blur();
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        flush.current(e.target);
        e.target.blur();
      }
    },
    ...rest,
  };

  return multiline ? <textarea {...shared} /> : <input {...shared} />;
}

/* ── right-click menu ──────────────────────────────────────────────────── */

export function useContextMenu() {
  const [menu, setMenu] = useState(null);
  const open = useCallback((e, items, extra = {}) => {
    e.preventDefault();
    e.stopPropagation();
    const usable = items.filter(Boolean);
    if (!usable.length) return;
    setMenu({ x: e.clientX, y: e.clientY, items: usable, ...extra });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

export function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: menu?.x ?? 0, y: menu?.y ?? 0 });

  useEffect(() => {
    if (!menu) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  // keep it on screen
  useEffect(() => {
    if (!menu) return;
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - box.width - 8),
      y: Math.min(menu.y, window.innerHeight - box.height - 8),
    });
  }, [menu]);

  if (!menu) return null;

  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.title && <div className="ctx-title eyebrow">{menu.title}</div>}
      {menu.items.map((item, i) => (
        item.divider
          ? <div key={`d${i}`} className="ctx-divider" />
          : (
            <button
              key={item.label}
              className={`ctx-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              role="menuitem"
              onClick={() => { onClose(); item.onClick?.(); }}
            >
              <span className="ctx-icon">{item.icon}</span>
              <span className="ctx-label">{item.label}</span>
              {item.hint && <span className="ctx-hint mono">{item.hint}</span>}
            </button>
          )
      ))}
    </div>
  );
}
