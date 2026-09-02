import { WebSocketServer } from 'ws';
import { userForSession, COOKIE } from './auth.js';

const rooms = new Map(); // room -> Set<socket>

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function join(sock, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(sock);
  sock.rooms.add(room);
  announce(room);
}

function leave(sock, room) {
  rooms.get(room)?.delete(sock);
  sock.rooms.delete(room);
  if (rooms.get(room)?.size === 0) rooms.delete(room);
  else announce(room);
}

function announce(room) {
  const peers = [...(rooms.get(room) || [])].map((s) => ({
    id: s.user.id,
    name: s.user.display_name,
    accent: s.user.accent,
    clientId: s.clientId,
  }));
  send(room, { t: 'presence', room, peers });
}

export function send(room, payload, exclude) {
  const set = rooms.get(room);
  if (!set) return;
  const raw = JSON.stringify(payload);
  for (const s of set) {
    if (s === exclude) continue;
    if (s.readyState === 1) s.send(raw);
  }
}

/** Broadcast a persisted change to everyone in a room, except the originator. */
export function broadcastOp(room, op, originClientId) {
  const set = rooms.get(room);
  if (!set) return;
  const raw = JSON.stringify({ t: 'op', room, op });
  for (const s of set) {
    if (originClientId && s.clientId === originClientId) continue;
    if (s.readyState === 1) s.send(raw);
  }
}

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (sock, req) => {
    const sid = readCookie(req.headers.cookie, COOKIE);
    const user = userForSession(sid);
    if (!user) {
      sock.close(4401, 'unauthorised');
      return;
    }
    sock.user = user;
    sock.rooms = new Set();
    sock.isAlive = true;
    const url = new URL(req.url, 'http://x');
    sock.clientId = url.searchParams.get('client') || Math.random().toString(36).slice(2);

    sock.send(JSON.stringify({ t: 'hello', clientId: sock.clientId, user: { id: user.id, name: user.display_name } }));

    sock.on('pong', () => { sock.isAlive = true; });

    sock.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.t === 'join' && typeof msg.room === 'string') join(sock, msg.room);
      else if (msg.t === 'leave' && typeof msg.room === 'string') leave(sock, msg.room);
      else if (msg.t === 'live' && sock.rooms.has(msg.room)) {
        // ephemeral: cursors + in-flight drags. never persisted.
        send(msg.room, { t: 'live', room: msg.room, from: sock.clientId, user: { id: user.id, name: user.display_name, accent: user.accent }, data: msg.data }, sock);
      }
    });

    sock.on('close', () => {
      for (const room of [...sock.rooms]) leave(sock, room);
    });
  });

  const beat = setInterval(() => {
    for (const s of wss.clients) {
      if (!s.isAlive) { s.terminate(); continue; }
      s.isAlive = false;
      try { s.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(beat));

  return wss;
}
