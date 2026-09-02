export const clientId = Math.random().toString(36).slice(2, 12);

async function request(method, url, body, isForm = false) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'x-client-id': clientId },
  };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error((payload && payload.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u, b) => request('DELETE', u, b),
  form: (u, fd) => request('POST', u, fd, true),
};

export const mediaUrl = (file) => `/media/${file}`;

export function humanBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
