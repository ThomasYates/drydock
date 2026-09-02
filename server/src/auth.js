import bcrypt from 'bcryptjs';
import { db, uid, now } from './db.js';

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
export const COOKIE = 'drydock_sid';

export const hash = (pw) => bcrypt.hashSync(pw, 11);
export const verify = (pw, h) => bcrypt.compareSync(pw, h);

export const DEFAULT_PREFS = { theme: 'dark', accent: '#e2a445', uiFont: 'archivo' };

export function readPrefs(raw) {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(raw || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    mustChangePassword: !!u.must_change_password,
    accent: u.accent,
    prefs: readPrefs(u.prefs),
    createdAt: u.created_at,
  };
}

export function createUser({ username, displayName, password, isAdmin = false, mustChange = false }) {
  const id = uid('u_');
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, is_admin, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username.trim(), (displayName || username).trim(), hash(password), isAdmin ? 1 : 0, mustChange ? 1 : 0, now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createSession(userId) {
  const id = uid('s_');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    id, userId, now(), expires
  );
  return { id, expires };
}

export function userForSession(sid) {
  if (!sid) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`
    )
    .get(sid, now());
  return row || null;
}

export function destroySession(sid) {
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

export function purgeExpired() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // SECURE_COOKIE alone. TRUST_PROXY only means "believe X-Forwarded-For",
    // which says nothing about whether there is TLS in front — marking the
    // cookie Secure behind a plain-HTTP proxy stops anyone signing in at all.
    secure: process.env.SECURE_COOKIE === '1',
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  };
}

export function attachUser(req, _res, next) {
  req.user = userForSession(req.cookies?.[COOKIE]);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

/*
 * Login throttle, keyed on username plus address. Five wrong guesses and the
 * wait doubles each time after that, up to a quarter of an hour.
 *
 * The map is swept hourly. Without that, an attacker spraying random usernames
 * would grow it without limit, which is a slower but perfectly good way to
 * take the process down.
 */
const FORGET_AFTER_MS = 60 * 60_000;
const attempts = new Map();

export function throttle(key) {
  const rec = attempts.get(key);
  if (!rec || rec.until <= Date.now()) return 0;
  return Math.ceil((rec.until - Date.now()) / 1000);
}

export function noteFailure(key) {
  const rec = attempts.get(key) || { n: 0, until: 0, seen: 0 };
  rec.n += 1;
  rec.seen = Date.now();
  if (rec.n >= 5) {
    rec.until = Date.now() + Math.min(15 * 60_000, 2 ** (rec.n - 5) * 30_000);
  }
  attempts.set(key, rec);
}

export function clearFailures(key) {
  attempts.delete(key);
}

const forget = setInterval(() => {
  const cutoff = Date.now() - FORGET_AFTER_MS;
  for (const [key, rec] of attempts) {
    if (rec.seen < cutoff && rec.until < Date.now()) attempts.delete(key);
  }
}, FORGET_AFTER_MS);
forget.unref();
