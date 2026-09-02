import { DEFAULT_FONT, fontStack } from './fonts.js';

export const DEFAULT_PREFS = { theme: 'dark', accent: '#e2a445', uiFont: DEFAULT_FONT };

export const ACCENTS = [
  { name: 'Brass', value: '#e2a445' },
  { name: 'Signal', value: '#59c2d6' },
  { name: 'Moss', value: '#6fbf8b' },
  { name: 'Flare', value: '#e0685f' },
  { name: 'Violet', value: '#9a8cf0' },
  { name: 'Rose', value: '#d98cc0' },
  { name: 'Sky', value: '#8fb3e0' },
  { name: 'Lime', value: '#b6cf5c' },
];

const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : DEFAULT_PREFS.accent);

const rgb = (v) => [
  parseInt(v.slice(1, 3), 16),
  parseInt(v.slice(3, 5), 16),
  parseInt(v.slice(5, 7), 16),
];

const toHex = (parts) =>
  `#${parts.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;

const shade = (v, amount) => toHex(rgb(v).map((c) => (amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)));

/** Rough perceived brightness, so text on the accent stays readable. */
export function inkOn(colour) {
  const [r, g, b] = rgb(hex(colour));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#141a22' : '#ffffff';
}

/** Paint the chosen look onto the document. */
export function applyTheme(prefs) {
  const { theme, accent, uiFont } = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const root = document.documentElement;
  const value = hex(accent);

  root.dataset.theme = theme === 'light' ? 'light' : 'dark';
  root.style.setProperty('--brass', value);
  root.style.setProperty('--brass-dim', shade(value, theme === 'light' ? 0.3 : -0.45));
  root.style.setProperty('--on-accent', inkOn(value));
  // only the interface face — moodboard notes keep whatever they were set to
  root.style.setProperty('--sans', fontStack(uiFont));

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eff2f6' : '#0e131a');
}

/**
 * Remembered locally as well as on the account, so the first paint after a
 * reload is already the right colour instead of flashing dark.
 */
export function cachePrefs(prefs) {
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {}
}

export function cachedPrefs() {
  try {
    const raw = localStorage.getItem('prefs');
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
