import { useCallback, useEffect, useRef, useState } from 'react';
import { live } from '../lib/realtime.js';

const IDLE_MS = 9000;

/**
 * Tracks where everyone else's pointer is, in world coordinates, and gives you
 * the handlers to broadcast your own.
 */
export function usePeerCursors(room, toWorld) {
  const [cursors, setCursors] = useState({});
  const lastSent = useRef(0);

  // drop anyone who has gone quiet
  useEffect(() => {
    const t = setInterval(() => {
      setCursors((c) => {
        const cutoff = Date.now() - IDLE_MS;
        const next = {};
        let dropped = false;
        for (const [id, v] of Object.entries(c)) {
          if (v.at > cutoff) next[id] = v; else dropped = true;
        }
        return dropped ? next : c;
      });
    }, 2500);
    return () => clearInterval(t);
  }, []);

  /** Feed this every `live` message the room receives. */
  const receive = useCallback((msg) => {
    if (msg.data?.kind === 'cursor') {
      setCursors((c) => ({
        ...c,
        [msg.from]: {
          x: msg.data.x, y: msg.data.y,
          name: msg.user.name, accent: msg.user.accent || '#e2a445',
          holding: msg.data.holding || 0,
          at: Date.now(),
        },
      }));
    } else if (msg.data?.kind === 'cursorOut') {
      setCursors((c) => { const n = { ...c }; delete n[msg.from]; return n; });
    }
  }, []);

  const forget = useCallback((clientId) => {
    setCursors((c) => { const n = { ...c }; delete n[clientId]; return n; });
  }, []);

  /** Attach to the stage. `holding` is how many things you are dragging. */
  const onPointerMove = useCallback((e, holding = 0) => {
    if (!room) return;
    const t = Date.now();
    if (t - lastSent.current < 40) return;
    lastSent.current = t;
    const w = toWorld(e.clientX, e.clientY);
    live(room, { kind: 'cursor', x: Math.round(w.x), y: Math.round(w.y), holding });
  }, [room, toWorld]);

  const onPointerLeave = useCallback(() => {
    if (room) live(room, { kind: 'cursorOut' });
  }, [room]);

  return { cursors, receive, forget, onPointerMove, onPointerLeave };
}

/** Cursors are drawn in screen space so they stay a constant size at any zoom. */
export function PeerCursors({ cursors, vp }) {
  const list = Object.entries(cursors);
  if (!list.length) return null;
  return (
    <div className="cursor-layer">
      {list.map(([id, c]) => (
        <div
          key={id}
          className="peer-cursor"
          style={{ transform: `translate(${c.x * vp.k + vp.x}px, ${c.y * vp.k + vp.y}px)` }}
        >
          <svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
            <path d="M2 1.5 17 11l-6.4 1.3L7.6 19z" fill={c.accent} stroke="#0e131a" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span className="peer-cursor-name" style={{ background: c.accent }}>
            {c.name}{c.holding > 0 && <em> · dragging {c.holding}</em>}
          </span>
        </div>
      ))}
    </div>
  );
}
