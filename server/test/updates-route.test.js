import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeClient, setupAdmin } from '../test-utils/harness.js';
import { channelFor, checkForUpdates, fetchLatestRelease, readStatus } from '../src/updates.js';

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

/** What the beta workflow writes: one pre-release whose name is the build. */
const betaRelease = (version) => ({
  tag_name: 'beta',
  name: version,
  prerelease: true,
  html_url: 'https://github.com/ThomasYates/drydock/releases/tag/beta',
  body: 'The current build of the beta branch.',
  published_at: '2026-04-02T09:00:00Z',
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

test('a build follows the channel it was built on', () => {
  assert.equal(channelFor('2.0.1'), 'stable');
  assert.equal(channelFor('2.0.1-beta.a1b2c3d'), 'beta');
  assert.equal(channelFor('2.0.1-BETA.a1b2c3d'), 'beta');
  assert.equal(channelFor('2.1.0-rc.1'), 'stable', 'a release candidate is not the beta branch');
  assert.equal(channelFor(undefined), 'stable');

  // this build is a released one, so that is what it watches
  assert.equal(readStatus().channel, 'stable');
});

test('the beta channel reads the beta pre-release, which stable never sees', async () => {
  const asked = [];
  const spy = (payload) => async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => payload };
  };

  const beta = await fetchLatestRelease('ThomasYates/drydock', {
    channel: 'beta',
    fetchImpl: spy(betaRelease('2.0.1-beta.a1b2c3d')),
  });
  assert.match(asked[0], /\/releases\/tags\/beta$/);
  assert.equal(beta.release.version, '2.0.1-beta.a1b2c3d');

  // the same payload on the stable channel is refused: it is a pre-release, and
  // its tag is not a version at all
  const stable = await fetchLatestRelease('ThomasYates/drydock', {
    channel: 'stable',
    fetchImpl: spy(betaRelease('2.0.1-beta.a1b2c3d')),
  });
  assert.match(asked[1], /\/releases\/latest$/);
  assert.equal(stable.release, null);
});

test('a channel with nothing published yet is not an error', async () => {
  const before = readStatus().latest;
  const status = await checkForUpdates({ force: true, fetchImpl: stub({}, 404) });
  assert.equal(status.error, null, 'nothing published is a normal state, not a failure');
  assert.equal(status.latest, before, 'and it leaves the last known answer alone');
});
