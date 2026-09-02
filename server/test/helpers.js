/*
 * A real server, a real SQLite file, real HTTP.
 *
 * Nothing here is mocked, because the things most likely to break in this
 * codebase are the seams — a cookie that does not stick, a route mounted at
 * the wrong path, a foreign key that fires on delete. A stub would agree with
 * whatever the test expected and prove none of it.
 *
 * `node --test` gives every file its own process, so one boot per file gets a
 * clean database with no cross-test bleed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/*
 * The environment is set here at module scope rather than inside boot(),
 * because a test file that imports something out of src/ directly gets that
 * module evaluated before any before() hook runs — and src/db.js opens its
 * file the moment it is loaded. Importing helpers.js first is all a test file
 * has to remember.
 */
export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.UPDATE_CHECK = '0';
process.env.SECURE_COOKIE = '0';
process.env.TRUST_PROXY = '0';
process.env.NODE_ENV = 'test';

let booted = null;

export async function boot() {
  if (booted) return booted;

  const dir = DATA_DIR;
  const { createApp } = await import('../src/app.js');
  const { db } = await import('../src/db.js');

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  booted = {
    dir,
    db,
    base,
    api: makeClient(base),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return booted;
}

/** A fetch wrapper that remembers the session cookie, the way a browser does. */
export function makeClient(base) {
  let cookie = null;

  async function request(method, url, body, { raw = false, headers = {} } = {}) {
    const head = { ...headers };
    if (cookie) head.cookie = cookie;

    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      head['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch(base + url, { method, headers: head, body: payload, redirect: 'manual' });

    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      if (pair.startsWith('drydock_sid=')) {
        cookie = pair.endsWith('=') ? null : pair;
      }
    }

    if (raw) return res;

    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, data };
  }

  return {
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    patch: (url, body, opts) => request('PATCH', url, body, opts),
    del: (url, body, opts) => request('DELETE', url, body, opts),
    raw: (method, url, body, opts) => request(method, url, body, { ...opts, raw: true }),
    forget() { cookie = null; },
    get cookie() { return cookie; },
  };
}

export const ADMIN = { username: 'skipper', displayName: 'The Skipper', password: 'a-long-enough-password' };

/** First run: create the admin and sign in as them. */
export async function setupAdmin(api, who = ADMIN) {
  const res = await api.post('/api/auth/setup', who);
  if (!res.ok) throw new Error(`setup failed: ${JSON.stringify(res.data)}`);
  return res.data.user;
}

export async function makeProject(api, name = 'Test project') {
  const res = await api.post('/api/projects', { name, summary: 'A project for testing' });
  if (!res.ok) throw new Error(`project create failed: ${JSON.stringify(res.data)}`);
  return res.data.project;
}

/** A tiny valid PNG, so the image routes have something real to re-encode. */
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
