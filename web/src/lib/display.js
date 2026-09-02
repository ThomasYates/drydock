/*
 * Settings that belong to the machine rather than the person. Scale is one of
 * those: the right size on a 4K monitor is the wrong size on a laptop, and the
 * same account gets used on both.
 */

export const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const DEFAULT_SCALE = 1;

const SCALE_KEY = 'ui-scale';
const MOBILE_KEY = 'mobile-warning-seen';

export function cachedScale() {
  try {
    const raw = Number(localStorage.getItem(SCALE_KEY));
    return SCALES.includes(raw) ? raw : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

export function applyScale(value) {
  const scale = SCALES.includes(value) ? value : DEFAULT_SCALE;
  document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
  try { localStorage.setItem(SCALE_KEY, String(scale)); } catch {}
  return scale;
}

export function stepScale(current, direction) {
  const i = SCALES.indexOf(current);
  const next = SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? SCALES.indexOf(DEFAULT_SCALE) : i) + direction))];
  return next;
}

/**
 * A phone, rather than just a narrow window. A desktop browser dragged narrow
 * still has a mouse, and everything here is built around one.
 */
export function looksLikeAPhone() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const narrow = window.matchMedia?.('(max-width: 900px)').matches;
  const ua = /Android|iPhone|iPod|Windows Phone|Mobile Safari|Silk/i.test(navigator.userAgent || '');
  return Boolean((coarse && narrow) || (ua && narrow));
}

export function mobileWarningSeen() {
  try { return localStorage.getItem(MOBILE_KEY) === '1'; } catch { return false; }
}

export function rememberMobileWarning() {
  try { localStorage.setItem(MOBILE_KEY, '1'); } catch {}
}
