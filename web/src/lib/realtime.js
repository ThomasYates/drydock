import { useEffect, useRef, useState } from 'react';
import { clientId } from './api.js';

let sock = null;
let open = false;
let retry = 0;
let timer = null;
const rooms = new Map(); // room -> Set<handler>
const queue = [];

function flush() {
  while (open && queue.length) sock.send(JSON.stringify(queue.shift()));
}

function push(msg) {
  queue.push(msg);
  if (open) flush();
}

function connect() {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  sock = new WebSocket(`${proto}://${location.host}/ws?client=${clientId}`);

  sock.onopen = () => {
    open = true;
    const wasDown = retry > 0;
    retry = 0;
    for (const room of rooms.keys()) sock.send(JSON.stringify({ t: 'join', room }));
    flush();
    if (wasDown) {
      for (const [room, set] of rooms) {
        for (const h of set) h({ t: 'resync', room });
      }
    }
  };

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const set = rooms.get(msg.room);
    if (!set) return;
    for (const h of set) h(msg);
  };

  sock.onclose = () => {
    open = false;
    if (!rooms.size) return;
    retry += 1;
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(12_000, 600 * 2 ** Math.min(retry, 5)));
  };

  sock.onerror = () => { try { sock.close(); } catch {} };
}

export function subscribe(room, handler) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(handler);
  connect();
  if (open) sock.send(JSON.stringify({ t: 'join', room }));
  return () => {
    const set = rooms.get(room);
    if (!set) return;
    set.delete(handler);
    if (!set.size) {
      rooms.delete(room);
      if (open) sock.send(JSON.stringify({ t: 'leave', room }));
    }
  };
}

/** Ephemeral broadcast — cursors and in-flight drags. Never stored. */
export function live(room, data) {
  if (open) sock.send(JSON.stringify({ t: 'live', room, data }));
}

/**
 * Join a room.
 * onOp   — a persisted change from someone else
 * onLive — an ephemeral update from someone else
 * onResync — connection came back; reload from the API
 */
export function useRoom(room, { onOp, onLive, onResync } = {}) {
  const [peers, setPeers] = useState([]);
  const refs = useRef({});
  refs.current = { onOp, onLive, onResync };

  useEffect(() => {
    if (!room) return undefined;
    const off = subscribe(room, (msg) => {
      const h = refs.current;
      if (msg.t === 'op') h.onOp?.(msg.op);
      else if (msg.t === 'live') h.onLive?.(msg);
      else if (msg.t === 'presence') setPeers(msg.peers.filter((p) => p.clientId !== clientId));
      else if (msg.t === 'resync') h.onResync?.();
    });
    return () => { off(); setPeers([]); };
  }, [room]);

  return peers;
}

export { push as sendRaw };
