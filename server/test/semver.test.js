import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewer, parseVersion } from '../src/semver.js';

test('parses a plain three-part version', () => {
  assert.deepEqual(parseVersion('1.6.0'), { major: 1, minor: 6, patch: 0, pre: [] });
});

test('tolerates a leading v and surrounding space', () => {
  assert.deepEqual(parseVersion('  v2.0.1 '), { major: 2, minor: 0, patch: 1, pre: [] });
});

test('fills in missing parts', () => {
  assert.deepEqual(parseVersion('3'), { major: 3, minor: 0, patch: 0, pre: [] });
  assert.deepEqual(parseVersion('3.2'), { major: 3, minor: 2, patch: 0, pre: [] });
});

test('splits a pre-release tag into dot-separated identifiers', () => {
  assert.deepEqual(parseVersion('1.0.0-rc.2'), { major: 1, minor: 0, patch: 0, pre: ['rc', 2] });
});

test('ignores build metadata', () => {
  assert.deepEqual(parseVersion('1.0.0+build.7'), { major: 1, minor: 0, patch: 0, pre: [] });
});

test('rejects anything that is not a version', () => {
  for (const bad of ['', null, undefined, 'latest', 'main', {}, 'v', '..']) {
    assert.equal(parseVersion(bad), null, `expected ${JSON.stringify(bad)} to be unparseable`);
  }
});

test('orders by major, then minor, then patch', () => {
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.7.0', '1.6.9'), 1);
  assert.equal(compareVersions('1.6.1', '1.6.0'), 1);
  assert.equal(compareVersions('1.6.0', '1.6.0'), 0);
  assert.equal(compareVersions('1.6.0', '1.6.1'), -1);
});

test('compares numerically, not as text', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
});

test('a pre-release sorts below the release it leads to', () => {
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-rc.1'), 1);
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0-rc.2'), -1);
  assert.equal(compareVersions('2.0.0-alpha', '2.0.0-beta'), -1);
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0-rc.1'), 0);
});

test('numeric pre-release identifiers sort below alphabetic ones', () => {
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('more pre-release identifiers beat fewer when the prefix matches', () => {
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1);
});

test('isNewer only says yes when both sides parse and the candidate wins', () => {
  assert.equal(isNewer('1.7.0', '1.6.0'), true);
  assert.equal(isNewer('1.6.0', '1.6.0'), false);
  assert.equal(isNewer('1.5.0', '1.6.0'), false);
  assert.equal(isNewer('nightly', '1.6.0'), false);
  assert.equal(isNewer('1.7.0', 'unknown'), false);
});
