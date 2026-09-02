import { Router } from 'express';
import { db, isInitialised, setSetting } from '../db.js';
import { VERSION } from '../version.js';
import {
  COOKIE, cookieOptions, createSession, createUser, destroySession,
  hash, publicUser, requireAdmin, requireAuth, verify,
  throttle, noteFailure, clearFailures, readPrefs,
} from '../auth.js';

const r = Router();

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password needs at least 10 characters';
  return null;
}

r.get('/state', (req, res) => {
  res.json({
    initialised: isInitialised(),
    user: publicUser(req.user),
    version: VERSION,
  });
});

/* First-run: create the admin. Only works while uninitialised. */
r.post('/setup', (req, res) => {
  if (isInitialised()) return res.status(409).json({ error: 'Already set up' });
  const { username, displayName, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username: 3–32 characters, letters, numbers, dot, dash, underscore' });
  }
  const pwErr = checkPassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const user = createUser({ username, displayName, password, isAdmin: true });
  setSetting('initialised', '1');
  const s = createSession(user.id);
  res.cookie(COOKIE, s.id, cookieOptions());
  res.json({ user: publicUser(user) });
});

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = `${(username || '').toLowerCase()}|${req.ip}`;
  const wait = throttle(key);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s` });

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username || '');
  if (!user || user.disabled || !verify(password || '', user.password_hash)) {
    noteFailure(key);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  clearFailures(key);
  const s = createSession(user.id);
  res.cookie(COOKIE, s.id, cookieOptions());
  res.json({ user: publicUser(user) });
});

r.post('/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

r.post('/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!req.user.must_change_password && !verify(current || '', req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  const err = checkPassword(next);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.cookies[COOKIE]);
  res.json({ ok: true });
});

r.post('/profile', requireAuth, (req, res) => {
  const { displayName, accent } = req.body || {};
  db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), accent = COALESCE(?, accent) WHERE id = ?')
    .run(displayName?.trim() || null, accent || null, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

const HEX = /^#[0-9a-fA-F]{6}$/;

r.post('/prefs', requireAuth, (req, res) => {
  const current = readPrefs(req.user.prefs);
  const { theme, accent } = req.body || {};
  const { uiFont } = req.body || {};
  const next = {
    theme: ['dark', 'light'].includes(theme) ? theme : current.theme,
    accent: HEX.test(accent || '') ? accent : current.accent,
    uiFont: /^[a-z0-9-]{1,32}$/.test(uiFont || '') ? uiFont : current.uiFont,
  };
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
  res.json({ prefs: next });
});

/**
 * Just enough about everyone else to put a name and a colour on a card. Any
 * signed-in person can read it; the full account list below stays admin-only,
 * because it carries who is disabled and who has never signed in.
 */
r.get('/members', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT id, display_name, accent FROM users WHERE disabled = 0 ORDER BY display_name').all();
  res.json({ members: rows.map((u) => ({ id: u.id, displayName: u.display_name, accent: u.accent })) });
});

/* ---------- admin ---------- */

r.get('/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json({ users: rows.map((u) => ({ ...publicUser(u), disabled: !!u.disabled })) });
});

r.post('/users', requireAuth, requireAdmin, (req, res) => {
  const { username, displayName, password, isAdmin } = req.body || {};
  if (!USERNAME_RE.test(username || '')) {
    return res.status(400).json({ error: 'Username: 3–32 characters, letters, numbers, dot, dash, underscore' });
  }
  const err = checkPassword(password);
  if (err) return res.status(400).json({ error: err });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: 'That username is taken' });
  const user = createUser({ username, displayName, password, isAdmin: !!isAdmin, mustChange: true });
  res.json({ user: publicUser(user) });
});

r.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  const { password, isAdmin, disabled, displayName } = req.body || {};

  if (password !== undefined) {
    const err = checkPassword(password);
    if (err) return res.status(400).json({ error: err });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash(password), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  }
  if (isAdmin !== undefined) {
    if (target.id === req.user.id && !isAdmin) {
      return res.status(400).json({ error: 'You cannot remove your own admin access' });
    }
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, target.id);
  }
  if (disabled !== undefined) {
    if (target.id === req.user.id && disabled) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, target.id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  }
  if (displayName !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(displayName).trim(), target.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});

r.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const admins = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1 AND disabled = 0').get().c;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'No such account' });
  if (target.is_admin && admins <= 1) return res.status(400).json({ error: 'Keep at least one admin' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default r;
