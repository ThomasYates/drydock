/*
 * The two blanket protections that apply to every request, kept together so
 * there is one place to look when something is being blocked.
 */

/**
 * A small in-memory sliding window. Drydock is a single process serving a
 * handful of people, so a Map is the right size of tool — but it is a Map that
 * would grow forever without the sweep below.
 */
export function rateLimit({ windowMs, max, message = 'Slow down a moment.' }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const key = req.ip || 'unknown';
    const stamps = (hits.get(key) || []).filter((t) => t > cutoff);

    if (stamps.length >= max) {
      const retryAfter = Math.ceil((stamps[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({ error: message });
    }

    stamps.push(now);
    hits.set(key, stamps);
    return next();
  };

  middleware.stop = () => clearInterval(sweep);
  middleware.reset = () => hits.clear();
  return middleware;
}

/*
 * Everything the app actually needs and nothing else. The two allowances worth
 * explaining:
 *
 *   'unsafe-inline' in style-src — React writes inline style attributes all
 *   over the canvases, which is what a style attribute is. It does not permit
 *   inline <script>.
 *
 *   fonts.googleapis.com / fonts.gstatic.com — the seven typefaces are loaded
 *   from Google Fonts by index.html. Self-hosting them would tighten this to
 *   'self' and is the obvious next step for an install with no outbound
 *   internet at all.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  // only meaningful over HTTPS, and actively unhelpful if it is not
  if (process.env.SECURE_COOKIE === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
