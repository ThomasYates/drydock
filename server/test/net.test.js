import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, resolveSafeUrl } from '../src/net.js';

test('loopback is blocked', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '0.0.0.0', '::']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('the RFC1918 private ranges are blocked', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('addresses either side of the 172.16/12 block are allowed', () => {
  assert.equal(isBlockedAddress('172.15.255.255'), false);
  assert.equal(isBlockedAddress('172.32.0.1'), false);
});

test('link-local, CGNAT, multicast and reserved space are blocked', () => {
  for (const ip of ['169.254.169.254', '100.64.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('IPv6 private, link-local and mapped-IPv4 forms are blocked', () => {
  for (const ip of ['fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '140.82.121.4', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('nonsense is treated as blocked rather than allowed', () => {
  for (const ip of ['', null, undefined, 'not-an-ip', '999.1.1.1']) {
    assert.equal(isBlockedAddress(ip), true);
  }
});

const resolver = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map((address) => ({ address }));
};

test('a public https URL resolves', async () => {
  const got = await resolveSafeUrl('https://example.com/a.png', { resolver: resolver({ 'example.com': ['93.184.216.34'] }) });
  assert.equal(got.ok, true);
});

test('only http and https are allowed', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:image/png;base64,AAA', 'gopher://x']) {
    const got = await resolveSafeUrl(url, { resolver: resolver({}) });
    assert.equal(got.ok, false, `${url} should be refused`);
    assert.match(got.error, /http/i);
  }
});

test('a hostname that resolves to a private address is refused', async () => {
  const got = await resolveSafeUrl('http://sneaky.example/x.png', {
    resolver: resolver({ 'sneaky.example': ['192.168.1.5'] }),
  });
  assert.equal(got.ok, false);
  assert.match(got.error, /private|internal/i);
});

test('one private address among several is enough to refuse', async () => {
  const got = await resolveSafeUrl('http://mixed.example/x.png', {
    resolver: resolver({ 'mixed.example': ['1.1.1.1', '169.254.169.254'] }),
  });
  assert.equal(got.ok, false);
});

test('an address written straight into the URL is checked too', async () => {
  const got = await resolveSafeUrl('http://127.0.0.1:8787/api/health', { resolver: resolver({}) });
  assert.equal(got.ok, false);
  assert.match(got.error, /private|internal/i);
});

test('a hostname that does not resolve is refused', async () => {
  const got = await resolveSafeUrl('http://nowhere.invalid/x.png', { resolver: resolver({}) });
  assert.equal(got.ok, false);
  assert.match(got.error, /resolve/i);
});

test('a malformed URL is refused', async () => {
  const got = await resolveSafeUrl('not a url at all', { resolver: resolver({}) });
  assert.equal(got.ok, false);
});
