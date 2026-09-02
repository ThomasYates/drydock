import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_K = 0.03;
const MAX_K = 6;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function useViewport(ref, storageKey) {
  const [vp, setVp] = useState(() => {
    try {
      const raw = localStorage.getItem(`vp:${storageKey}`);
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.k)) return p;
      }
    } catch {}
    return { x: 200, y: 160, k: 1 };
  });
  const [panning, setPanning] = useState(false);
  const [wheelZoom, setWheelZoom] = useState(() => localStorage.getItem('wheelZoom') !== '0');
  const vpRef = useRef(vp);
  vpRef.current = vp;

  useEffect(() => {
    if (!storageKey) return;
    const id = setTimeout(() => {
      try { localStorage.setItem(`vp:${storageKey}`, JSON.stringify(vp)); } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [vp, storageKey]);

  const rect = useCallback(() => ref.current?.getBoundingClientRect() || { left: 0, top: 0, width: 1, height: 1 }, [ref]);

  const toWorld = useCallback((clientX, clientY) => {
    const r = rect();
    const v = vpRef.current;
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  }, [rect]);

  const zoomAt = useCallback((clientX, clientY, factor) => {
    const r = rect();
    setVp((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const ratio = k / v.k;
      const cx = clientX - r.left;
      const cy = clientY - r.top;
      return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, [rect]);

  const zoomToCentre = useCallback((factor) => {
    const r = rect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }, [rect, zoomAt]);

  /** Frame a world-space box. */
  const fit = useCallback((box, pad = 90) => {
    const r = rect();
    if (!box || !Number.isFinite(box.w) || box.w <= 0) { setVp({ x: r.width / 2, y: r.height / 2, k: 1 }); return; }
    const k = clamp(Math.min((r.width - pad * 2) / box.w, (r.height - pad * 2) / box.h), MIN_K, 1.6);
    setVp({
      k,
      x: r.width / 2 - (box.x + box.w / 2) * k,
      y: r.height / 2 - (box.y + box.h / 2) * k,
    });
  }, [rect]);

  /** Put the middle of the board back under the middle of the screen. */
  const home = useCallback(() => {
    const r = rect();
    setVp({ k: 1, x: Math.round(r.width / 2), y: Math.round(r.height / 2) });
  }, [rect]);

  const resetZoom = useCallback(() => {
    const r = rect();
    setVp((v) => {
      const ratio = 1 / v.k;
      const cx = r.width / 2;
      const cy = r.height / 2;
      return { k: 1, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, [rect]);

  // wheel: needs a non-passive listener to stop the page scrolling
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const pinch = e.ctrlKey || e.metaKey;
      if (pinch || wheelZoom) {
        const step = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
        zoomAt(e.clientX, e.clientY, Math.exp(-step * 0.0016));
      } else {
        setVp((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, zoomAt, wheelZoom]);

  // space held = temporary pan tool
  const spaceRef = useRef(false);
  useEffect(() => {
    const tag = (e) => ['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable;
    const down = (e) => { if (e.code === 'Space' && !tag(e)) { spaceRef.current = true; e.preventDefault(); } };
    const up = (e) => { if (e.code === 'Space') spaceRef.current = false; };
    const blur = () => { spaceRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // a right-drag pans; a right-click opens a menu. this tells them apart.
  const pannedAt = useRef(0);

  /** Returns true when the pointer event was consumed as a pan. */
  const maybePan = useCallback((e) => {
    const wantsPan = e.button === 1 || e.button === 2 || spaceRef.current;
    if (!wantsPan) return false;
    e.preventDefault();
    setPanning(true);
    const start = { x: e.clientX, y: e.clientY, vx: vpRef.current.x, vy: vpRef.current.y };
    let travelled = 0;
    const move = (ev) => {
      travelled = Math.max(travelled, Math.hypot(ev.clientX - start.x, ev.clientY - start.y));
      setVp((v) => ({ ...v, x: start.vx + (ev.clientX - start.x), y: start.vy + (ev.clientY - start.y) }));
    };
    const end = () => {
      setPanning(false);
      if (travelled > 4) pannedAt.current = Date.now();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    return true;
  }, []);

  /** True just after a right-drag pan, so the menu does not pop up afterwards. */
  const recentlyPanned = useCallback(() => Date.now() - pannedAt.current < 300, []);

  const toggleWheel = useCallback(() => {
    setWheelZoom((w) => {
      localStorage.setItem('wheelZoom', w ? '0' : '1');
      return !w;
    });
  }, []);

  return { vp, setVp, toWorld, zoomAt, zoomToCentre, resetZoom, home, fit, panning, maybePan, recentlyPanned, wheelZoom, toggleWheel, isSpaceDown: () => spaceRef.current };
}

/** Dot grid that keeps a readable density at any zoom. */
export function gridStyle(vp) {
  let step = 48;
  while (step * vp.k < 18) step *= 4;
  while (step * vp.k > 190) step /= 2;
  const s = step * vp.k;
  const major = s * 4;
  return {
    backgroundImage: `
      radial-gradient(circle at 1px 1px, var(--grid-dot) 1px, transparent 0),
      linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
      linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)`,
    backgroundSize: `${s}px ${s}px, ${major}px ${major}px, ${major}px ${major}px`,
    backgroundPosition: `${vp.x}px ${vp.y}px, ${vp.x}px ${vp.y}px, ${vp.x}px ${vp.y}px`,
  };
}

export function boundsOf(list, getBox) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of list) {
    const b = getBox(it);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
