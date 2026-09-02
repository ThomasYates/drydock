import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, boot, makeClient } from '../test-utils/harness.js';

let app;
let api;

before(async () => { app = await boot(); api = app.api; });
after(async () => { await app.stop(); });

test('a fresh install reports itself as uninitialised', async () => {
  const res = await api.get('/api/auth/state');
  assert.equal(res.ok, true);
  assert.equal(res.data.initialised, false);
  assert.equal(res.data.user, null);
});

test('the health endpoint needs no account', async () => {
  const res = await api.get('/api/health');
  assert.equal(res.data.ok, true);
  assert.ok(res.data.version);
});

test('setup refuses a username with characters it does not allow', async () => {
  const res = await api.post('/api/auth/setup', { ...ADMIN, username: 'no spaces' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Username/);
});

test('setup refuses a short password', async () => {
  const res = await api.post('/api/auth/setup', { ...ADMIN, password: 'short' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /10 characters/);
});

test('setup creates the first account as an admin and signs them in', async () => {
  const res = await api.post('/api/auth/setup', ADMIN);
  assert.equal(res.ok, true);
  assert.equal(res.data.user.isAdmin, true);
  assert.equal(res.data.user.username, ADMIN.username);
  assert.ok(api.cookie, 'a session cookie should have been set');

  const state = await api.get('/api/auth/state');
  assert.equal(state.data.initialised, true);
  assert.equal(state.data.user.username, ADMIN.username);
});

test('setup cannot be run twice', async () => {
  const res = await api.post('/api/auth/setup', { ...ADMIN, username: 'second' });
  assert.equal(res.status, 409);
});

test('there is no public sign-up: creating an account needs an admin session', async () => {
  api.forget();
  const res = await api.post('/api/auth/users', {
    username: 'stranger', displayName: 'Stranger', password: 'another-long-password',
  });
  assert.equal(res.status, 401);
});

test('the wrong password is refused', async () => {
  const res = await api.post('/api/auth/login', { username: ADMIN.username, password: 'not-it-at-all' });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /Wrong username or password/);
});

test('an unknown username fails the same way as a wrong password', async () => {
  const res = await api.post('/api/auth/login', { username: 'ghost', password: 'not-it-at-all' });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /Wrong username or password/);
});

test('the right password signs in', async () => {
  const res = await api.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
  assert.equal(res.ok, true);
  assert.equal(res.data.user.isAdmin, true);
});

test('the username is not case sensitive', async () => {
  const res = await api.post('/api/auth/login', { username: ADMIN.username.toUpperCase(), password: ADMIN.password });
  assert.equal(res.ok, true);
});

test('an admin can create an account, and it must change its password', async () => {
  const res = await api.post('/api/auth/users', {
    username: 'mate', displayName: 'First Mate', password: 'handed-over-in-person',
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.user.mustChangePassword, true);
  assert.equal(res.data.user.isAdmin, false);
});

test('a username cannot be taken twice', async () => {
  const res = await api.post('/api/auth/users', {
    username: 'MATE', displayName: 'Impostor', password: 'handed-over-in-person',
  });
  assert.equal(res.status, 409);
});

test('an admin cannot remove their own admin access or disable themselves', async () => {
  const me = (await api.get('/api/auth/state')).data.user;
  assert.equal((await api.patch(`/api/auth/users/${me.id}`, { isAdmin: false })).status, 400);
  assert.equal((await api.patch(`/api/auth/users/${me.id}`, { disabled: true })).status, 400);
  assert.equal((await api.del(`/api/auth/users/${me.id}`)).status, 400);
});

test('every signed-in person can read the member list, without private details', async () => {
  const res = await api.get('/api/auth/members');
  assert.equal(res.ok, true);
  assert.ok(res.data.members.length >= 2);
  for (const m of res.data.members) {
    assert.deepEqual(Object.keys(m).sort(), ['accent', 'displayName', 'id']);
  }
});

test('a member cannot read the full account list', async () => {
  const member = makeClient(app.base);
  await member.post('/api/auth/login', { username: 'mate', password: 'handed-over-in-person' });
  const res = await member.get('/api/auth/users');
  assert.equal(res.status, 403);
});

test('changing a password signs the other sessions out', async () => {
  const one = makeClient(app.base);
  const two = makeClient(app.base);
  await one.post('/api/auth/login', { username: 'mate', password: 'handed-over-in-person' });
  await two.post('/api/auth/login', { username: 'mate', password: 'handed-over-in-person' });

  const changed = await one.post('/api/auth/password', { next: 'a-brand-new-password' });
  assert.equal(changed.ok, true);

  assert.equal((await two.get('/api/auth/state')).data.user, null, 'the other session should be gone');
  assert.ok((await one.get('/api/auth/state')).data.user, 'the session that changed it stays');
});

test('preferences only accept values the app knows about', async () => {
  const res = await api.post('/api/auth/prefs', { theme: 'neon', accent: 'red', uiFont: '../../etc' });
  assert.equal(res.ok, true);
  assert.ok(['dark', 'light'].includes(res.data.prefs.theme));
  assert.match(res.data.prefs.accent, /^#[0-9a-fA-F]{6}$/);
  assert.match(res.data.prefs.uiFont, /^[a-z0-9-]{1,32}$/);
});

test('signing out clears the cookie', async () => {
  const client = makeClient(app.base);
  await client.post('/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
  assert.ok((await client.get('/api/auth/state')).data.user);
  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/auth/state')).data.user, null);
});

test('repeated wrong guesses get throttled', async () => {
  const client = makeClient(app.base);
  let throttled = false;
  for (let i = 0; i < 8; i += 1) {
    const res = await client.post('/api/auth/login', { username: 'throttle-me', password: 'wrong-every-time' });
    if (res.status === 429) { throttled = true; break; }
  }
  assert.equal(throttled, true, 'the login throttle should have kicked in');
});
