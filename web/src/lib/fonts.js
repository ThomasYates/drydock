/**
 * A deliberately small set. Everything here is loaded once in index.html, so
 * adding to this list means adding to that link tag too.
 */
export const FONTS = [
  {
    id: 'archivo',
    name: 'Archivo',
    kind: 'Sans',
    stack: "'Archivo', system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  {
    id: 'space-grotesk',
    name: 'Space Grotesk',
    kind: 'Sans',
    stack: "'Space Grotesk', 'Archivo', system-ui, sans-serif",
  },
  {
    id: 'barlow-condensed',
    name: 'Barlow Condensed',
    kind: 'Condensed',
    stack: "'Barlow Condensed', 'Archivo Narrow', system-ui, sans-serif",
  },
  {
    id: 'lora',
    name: 'Lora',
    kind: 'Serif',
    stack: "'Lora', Georgia, 'Times New Roman', serif",
  },
  {
    id: 'instrument-serif',
    name: 'Instrument Serif',
    kind: 'Display serif',
    stack: "'Instrument Serif', Georgia, serif",
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    kind: 'Mono',
    stack: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },
  {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    kind: 'Mono',
    stack: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },
];

export const DEFAULT_FONT = 'archivo';

const byId = new Map(FONTS.map((f) => [f.id, f]));

export const fontStack = (id) => (byId.get(id) || byId.get(DEFAULT_FONT)).stack;
export const fontName = (id) => (byId.get(id) || byId.get(DEFAULT_FONT)).name;
