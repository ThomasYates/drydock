import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeClient, setupAdmin } from './helpers.js';
import { checkForUpdates, readStatus } from '../src/updates.js';

let app;
let api;

before(async () => {
  app = await boot();
  api = app.api;
  await setupAdmin(api);
});
after(async () => { await app.stop(); });

const release = (version) => ({
  tag_name: `v${version}`,
  name: `Drydock ${version}`,
  html_url: `https://github.com/ThomasYates/drydock/releases/tag/v${version}`,
  body: 'What changed.',
  published_at: '2026-04-01T09:00:00Z',
});

const stub = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test('the status endpoint needs an account', async () => {
  const stranger = makeClient(app.base);
  assert.equal((await stranger.get('/api/updates')).status, 401);
});

test('with checks switched off it says so and offers nothing', async () => {
  process.env.UPDATE_CHECK = '0';
  const res = await api.get('/api/updates');
  assert.equal(res.ok, true);
  assert.equal(res.data.enabled, false);
  assert.equal(res.data.updateAvailable, false);
  assert.ok(res.data.current, 'it still reports the version it is running');
});

test('a newer release on GitHub is reported as available', async () => {
  process.env.UPDATE_CHECK = '1';
  const status = await checkForUpdates({ force: true, fetchImpl: stub(release('99.0.0')) });

  assert.equal(status.enabled, true);
  assert.equal(status.latest, '99.0.0');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.release.url, 'https://github.com/ThomasYates/drydock/releases/tag/v99.0.0');
  assert.equal(status.error, null);
  assert.ok(status.checkedAt);
});

test('the web app reads that same answer back with no network of its own', async () => {
  const res = await api.get('/api/updates');
  assert.equal(res.data.latest, '99.0.0');
  assert.equal(res.data.updateAvailable, true);
  assert.equal(res.data.release.notes, 'What changed.');
});

test('the same version, or an older one, is not an update', async () => {
  const current = readStatus().current;
  const same = await checkForUpdates({ force: true, fetchImpl: stub(release(current)) });
  assert.equal(same.updateAvailable, false);

  const older = await checkForUpdates({ force: true, fetchImpl: stub(release('0.0.1')) });
  assert.equal(older.updateAvailable, false);
});

test('a failed check keeps the last good answer and reports the failure', async () => {
  await checkForUpdates({ force: true, fetchImpl: stub(release('99.0.0')) });
  const failed = await checkForUpdates({ force: true, fetchImpl: stub({}, 500) });

  assert.equal(failed.latest, '99.0.0', 'the last known release is not thrown away');
  assert.match(failed.error, /500/);
});

test('a fresh answer is reused rather than asking GitHub again', async () => {
  await checkForUpdates({ force: true, fetchImpl: stub(release('99.0.0')) });

  let calls = 0;
  await checkForUpdates({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => release('1.0.0') }; } });
  assert.equal(calls, 0, 'the cached answer was still fresh');
});

test('only an admin can force a check', async () => {
  await api.post('/api/auth/users', { username: 'crew', displayName: 'Crew', password: 'a-long-first-password' });
  const member = makeClient(app.base);
  await member.post('/api/auth/login', { username: 'crew', password: 'a-long-first-password' });
  await member.post('/api/auth/password', { next: 'a-long-chosen-password' });

  assert.equal((await member.get('/api/updates')).ok, true, 'anyone can read the status');
  assert.equal((await member.post('/api/updates/check')).status, 403, 'only an admin can go and look');
});

test('holding the check button down does not turn into a stream of requests', async () => {
  process.env.UPDATE_REPO = 'ThomasYates/drydock';
  const first = await api.post('/api/updates/check');
  const second = await api.post('/api/updates/check');

  assert.ok(first.status === 200 || first.status === 429);
  assert.equal(second.status, 429, 'the second one straight after is refused');
  assert.match(second.data.error, /Just checked/);
});
