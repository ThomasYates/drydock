import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* ── icons (16px, currentColor) ───────────────────────────── */
const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
export const Icon = {
  Mark: (s) => (<svg width="20" height="20" viewBox="0 0 24 24" {...s}><path {...p} strokeWidth="2" d="M4 19h16M4 19V9l8-4 8 4v10" /><path {...p} d="M9 19v-5h6v5" /></svg>),
  Plus: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M12 5v14M5 12h14" /></svg>),
  Image: () => (<svg width="15" height="15" viewBox="0 0 24 24"><rect {...p} x="3" y="4" width="18" height="16" rx="2" /><circle {...p} cx="8.5" cy="9.5" r="1.6" /><path {...p} d="m3 16 5-4 4 3 3-2 6 5" /></svg>),
  Text: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M5 6h14M9 6v13M15 6v6" /></svg>),
  Board: () => (<svg width="15" height="15" viewBox="0 0 24 24"><rect {...p} x="3" y="4" width="18" height="16" rx="2" /><path {...p} d="M3 10h18M11 10v10" /></svg>),
  Frame: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M6 3v18M18 3v18M3 6h18M3 18h18" /></svg>),
  Link: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M10 13a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7L11.5 6" /><path {...p} d="M14 11a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7L12.5 18" /></svg>),
  Trash: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>),
  Fit: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>),
  Zoom: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="11" cy="11" r="6.5" /><path {...p} d="m16 16 4.5 4.5" /></svg>),
  Script: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M6 3h9l4 4v14H6z" /><path {...p} d="M14 3v5h5M9 13h7M9 17h5" /></svg>),
  Copy: () => (<svg width="15" height="15" viewBox="0 0 24 24"><rect {...p} x="9" y="9" width="12" height="12" rx="2" /><path {...p} d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>),
  Close: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M6 6l12 12M18 6 6 18" /></svg>),
  Up: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M12 19V5M6 11l6-6 6 6" /></svg>),
  Down: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M12 5v14M6 13l6 6 6-6" /></svg>),
  Back: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M19 12H5M11 6l-6 6 6 6" /></svg>),
  Users: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="9" cy="8" r="3.2" /><path {...p} d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path {...p} d="M16 5.5a3.2 3.2 0 0 1 0 6M18 20c0-2.4-.9-4.1-2.3-5.1" /></svg>),
  Gear: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="3" /><path {...p} d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" /></svg>),
  Target: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" /><path {...p} d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg>),
  Download: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /><path {...p} d="M4 18v2h16v-2" /></svg>),
  Cover: () => (<svg width="15" height="15" viewBox="0 0 24 24"><rect {...p} x="3" y="4" width="18" height="16" rx="2" /><path {...p} d="m3 16 5-4 3.5 2.6" /><path {...p} d="m16.4 8.2.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2L13.5 10.4l2-.3z" /></svg>),
  Font: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M3 18 8 6l5 12M4.6 14.2h6.8" /><path {...p} d="M14.5 12.4c1.7-1.4 5-1.2 5 1.2V18M19.5 14.6c-3.6 0-5.2.8-5.2 2 0 .9.8 1.6 2 1.6 1.5 0 3.2-1 3.2-2.6" /></svg>),
  User: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="12" cy="8" r="3.6" /><path {...p} d="M4.5 20c0-3.9 3.4-6.4 7.5-6.4s7.5 2.5 7.5 6.4" /></svg>),
  Palette: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M12 3a9 9 0 1 0 0 18c1.3 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.7 1.8-1.7H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z" /><circle {...p} cx="7.5" cy="11.5" r="1.1" /><circle {...p} cx="11" cy="7.5" r="1.1" /><circle {...p} cx="15.5" cy="8.5" r="1.1" /></svg>),
  Sun: () => (<svg width="15" height="15" viewBox="0 0 24 24"><circle {...p} cx="12" cy="12" r="4" /><path {...p} d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5m0-14.2-1.5 1.5M6.4 17.6l-1.5 1.5" /></svg>),
  Moon: () => (<svg width="15" height="15" viewBox="0 0 24 24"><path {...p} d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>),
  Node: () => (<svg width="15" height="15" viewBox="0 0 24 24"><rect {...p} x="3" y="9" width="7" height="6" rx="1.5" /><rect {...p} x="14" y="4" width="7" height="6" rx="1.5" /><rect {...p} x="14" y="14" width="7" height="6" rx="1.5" /><path {...p} d="M10 12h2.5m0 0V7H14m-1.5 5v5H14" /></svg>),
};

/* ── toast ────────────────────────────────────────────────── */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }) {
  const [msg, setMsg] = useState(null);
  const say = useCallback((text) => {
    setMsg({ text, id: Math.random() });
  }, []);
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <ToastCtx.Provider value={say}>
      {children}
      {msg && <div className="toast" role="status">{msg.text}</div>}
    </ToastCtx.Provider>
  );
}

/* ── modal ────────────────────────────────────────────────── */
export function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal card" style={wide ? { maxWidth: 640 } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2 style={{ flex: 1, fontSize: 15 }}>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><Icon.Close /></button>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Peers({ peers }) {
  if (!peers.length) return null;
  return (
    <div className="peers" title={peers.map((x) => x.name).join(', ')}>
      {peers.slice(0, 4).map((x) => (
        <div key={x.clientId} className="peer" style={{ background: x.accent || '#e2a445' }}>
          {x.name.slice(0, 1).toUpperCase()}
        </div>
      ))}
      {peers.length > 4 && <div className="peer" style={{ background: 'var(--panel-3)', color: 'var(--text)' }}>+{peers.length - 4}</div>}
    </div>
  );
}

export function Empty({ title, hint, action }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {hint && <p className="hint" style={{ margin: 0, maxWidth: 380 }}>{hint}</p>}
      {action}
    </div>
  );
}
