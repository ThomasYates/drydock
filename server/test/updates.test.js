import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestRelease, normaliseRelease, validRepo } from '../src/updates.js';

const RELEASE = {
  tag_name: 'v2.1.0',
  name: 'Drydock 2.1.0',
  html_url: 'https://github.com/ThomasYates/drydock/releases/tag/v2.1.0',
  body: 'Adds a thing.\nFixes another.',
  published_at: '2026-03-01T10:00:00Z',
  prerelease: false,
  draft: false,
};

const okFetch = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test('a repo must be exactly owner/name', () => {
  assert.equal(validRepo('ThomasYates/drydock'), true);
  assert.equal(validRepo('some-org/some.repo_1'), true);
  assert.equal(validRepo('ThomasYates/drydock/extra'), false);
  assert.equal(validRepo('../../etc/passwd'), false);
  assert.equal(validRepo('nossslash'), false);
  assert.equal(validRepo('has space/repo'), false);
  assert.equal(validRepo(''), false);
  assert.equal(validRepo(null), false);
});

test('normalises a GitHub release into the shape the app uses', () => {
  assert.deepEqual(normaliseRelease(RELEASE), {
    version: '2.1.0',
    name: 'Drydock 2.1.0',
    url: 'https://github.com/ThomasYates/drydock/releases/tag/v2.1.0',
    notes: 'Adds a thing.\nFixes another.',
    publishedAt: '2026-03-01T10:00:00Z',
  });
});

test('falls back to the tag when a release has no name', () => {
  assert.equal(normaliseRelease({ ...RELEASE, name: '' }).name, 'v2.1.0');
});

test('release notes are capped so one enormous changelog cannot bloat the database', () => {
  const huge = normaliseRelease({ ...RELEASE, body: 'x'.repeat(50_000) });
  assert.ok(huge.notes.length <= 12_100, `notes were ${huge.notes.length} characters`);
  assert.ok(huge.notes.endsWith('…'));
});

test('anything without a usable tag is not a release', () => {
  assert.equal(normaliseRelease(null), null);
  assert.equal(normaliseRelease({}), null);
  assert.equal(normaliseRelease({ tag_name: '' }), null);
  assert.equal(normaliseRelease({ tag_name: 'nightly' }), null);
  assert.equal(normaliseRelease('not an object'), null);
});

test('drafts and pre-releases are ignored', () => {
  assert.equal(normaliseRelease({ ...RELEASE, draft: true }), null);
  assert.equal(normaliseRelease({ ...RELEASE, prerelease: true }), null);
});

test('fetches and returns the latest release', async () => {
  const got = await fetchLatestRelease('ThomasYates/drydock', { fetchImpl: okFetch(RELEASE) });
  assert.equal(got.release.version, '2.1.0');
  assert.equal(got.error, null);
});

test('calls the releases endpoint for the configured repo only', async () => {
  let seen = null;
  await fetchLatestRelease('ThomasYates/drydock', {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => RELEASE }; },
  });
  assert.equal(seen.url, 'https://api.github.com/repos/ThomasYates/drydock/releases/latest');
  assert.match(seen.opts.headers['user-agent'], /^Drydock\//);
});

test('a repo with no releases yet is not an error', async () => {
  const got = await fetchLatestRelease('ThomasYates/drydock', { fetchImpl: okFetch({}, 404) });
  assert.equal(got.release, null);
  assert.equal(got.error, null);
});

test('being rate limited says so in plain words', async () => {
  const got = await fetchLatestRelease('ThomasYates/drydock', { fetchImpl: okFetch({}, 403) });
  assert.equal(got.release, null);
  assert.match(got.error, /rate limit/i);
});

test('any other bad response is reported rather than thrown', async () => {
  const got = await fetchLatestRelease('ThomasYates/drydock', { fetchImpl: okFetch({}, 500) });
  assert.equal(got.release, null);
  assert.match(got.error, /500/);
});

test('a network failure is reported rather than thrown', async () => {
  const got = await fetchLatestRelease('ThomasYates/drydock', {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(got.release, null);
  assert.match(got.error, /Could not reach GitHub/);
});

test('a malformed repo never reaches the network', async () => {
  let called = false;
  const got = await fetchLatestRelease('../../evil', { fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(got.release, null);
  assert.match(got.error, /owner\/name/);
});
