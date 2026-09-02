/*
 * Guarding the one place Drydock makes an outbound request on someone's
 * behalf: "add an image from a URL".
 *
 * Left unchecked that is a server-side request forgery hole — a signed-in
 * member could paste http://169.254.169.254/ or the address of anything else
 * on the host's network and get the response back as a picture. So before
 * anything is fetched the hostname is resolved and every address it points at
 * is checked against the ranges that are not the public internet, and each
 * redirect hop is checked the same way rather than being followed blindly.
 *
 * The residual gap is DNS rebinding: a name that answers with a public address
 * here and a private one microseconds later when the socket is opened. Closing
 * that means pinning the connection to the address that was checked, which
 * Node's fetch does not expose. It is a narrow window and the payoff is a
 * picture, so this stops where it stops.
 */
import dns from 'node:dns/promises';

const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Parts(address) {
  const m = IPV4.exec(address);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function blockedIpv4([a, b]) {
  if (a === 0) return true;                       // "this network"
  if (a === 10) return true;                      // private
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;        // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;          // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                      // multicast, reserved, broadcast
  return false;
}

/**
 * True for anything that is not a routable public address — and for anything
 * that cannot be parsed at all, so an unrecognised form fails closed.
 */
export function isBlockedAddress(address) {
  if (typeof address !== 'string' || !address) return true;

  const plain = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const four = ipv4Parts(plain);
  if (four) return blockedIpv4(four);

  if (!plain.includes(':')) return true; // not an address in any form we know

  // ::ffff:10.0.0.1 and the like are IPv4 wearing an IPv6 coat
  const mapped = /^::ffff:(.+)$/.exec(plain);
  if (mapped) {
    const inner = ipv4Parts(mapped[1]);
    return inner ? blockedIpv4(inner) : true;
  }

  if (plain === '::' || plain === '::1') return true;   // unspecified, loopback
  if (/^f[cd]/.test(plain)) return true;                // fc00::/7 unique local
  if (/^fe[89ab]/.test(plain)) return true;             // fe80::/10 link-local
  if (plain.startsWith('ff')) return true;              // ff00::/8 multicast
  if (plain.startsWith('64:ff9b:')) return true;        // NAT64
  if (plain.startsWith('2001:db8:')) return true;       // documentation

  return false;
}

/**
 * Check one URL: right scheme, resolvable host, and every address it resolves
 * to on the public internet. Returns { ok } or { ok: false, error }.
 */
export async function resolveSafeUrl(input, { resolver = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, error: 'That is not a web address.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https addresses can be fetched.' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // an address typed straight in never needs resolving, and must still pass
  if (ipv4Parts(host) || host.includes(':')) {
    if (isBlockedAddress(host)) {
      return { ok: false, error: 'That address is on a private or internal network.' };
    }
    return { ok: true, url };
  }

  let addresses;
  try {
    const found = await resolver(host, { all: true, verbatim: true });
    addresses = (Array.isArray(found) ? found : [found]).map((a) => a.address).filter(Boolean);
  } catch {
    return { ok: false, error: `Could not resolve ${host}.` };
  }
  if (!addresses.length) return { ok: false, error: `Could not resolve ${host}.` };

  // one bad answer is enough — a name that round-robins onto an internal box
  // must not become fetchable just because the first address looked fine
  if (addresses.some(isBlockedAddress)) {
    return { ok: false, error: 'That address is on a private or internal network.' };
  }

  return { ok: true, url };
}

/**
 * Fetch a URL that has been checked, following redirects by hand so each hop
 * is checked too, and giving up the moment the body goes over the limit
 * instead of buffering something enormous first.
 */
export async function fetchChecked(input, { maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, resolver } = {}) {
  let target = input;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safe = await resolveSafeUrl(target, resolver ? { resolver } : {});
    if (!safe.ok) return { ok: false, error: safe.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(safe.url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'Drydock', accept: 'image/*' },
      });
    } catch {
      clearTimeout(timer);
      return { ok: false, error: 'Could not fetch that address.' };
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      target = new URL(res.headers.get('location'), safe.url).toString();
      continue;
    }

    try {
      if (!res.ok) return { ok: false, error: `That address returned ${res.status}.` };

      const declared = Number(res.headers.get('content-length') || 0);
      if (maxBytes && declared > maxBytes) {
        return { ok: false, error: 'That image is over the size limit.' };
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          controller.abort();
          return { ok: false, error: 'That image is over the size limit.' };
        }
        chunks.push(chunk);
      }
      return { ok: true, buffer: Buffer.concat(chunks), url: safe.url };
    } catch {
      return { ok: false, error: 'Could not read that image.' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: 'That address redirects too many times.' };
}
