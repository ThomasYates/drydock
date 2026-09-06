import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { CHANNELS, checkForUpdates, readStatus, setChannel } from '../updates.js';

const r = Router();
r.use(requireAuth);

/**
 * What we already know, with no network access. The banner in the web app
 * polls this, so it has to be cheap and it has to never block.
 */
r.get('/', (_req, res) => res.json(readStatus()));

/**
 * The admin's Check for updates button. Admin-only because it reaches out to
 * the internet, and rate limited by hand so holding the button down cannot
 * turn into a stream of requests to GitHub.
 */
let lastForced = 0;
const FORCE_COOLDOWN_MS = 10_000;

r.post('/check', requireAdmin, async (_req, res) => {
  const since = Date.now() - lastForced;
  if (since < FORCE_COOLDOWN_MS) {
    // the status spread has an `error` field of its own, so it goes first
    return res.status(429).json({
      ...readStatus(),
      error: `Just checked. Try again in ${Math.ceil((FORCE_COOLDOWN_MS - since) / 1000)}s.`,
    });
  }
  lastForced = Date.now();
  try {
    return res.json(await checkForUpdates({ force: true }));
  } catch (e) {
    console.error('forced update check failed', e);
    return res.status(502).json({ ...readStatus(), error: 'The check could not be completed.' });
  }
});

/**
 * Which channel this install watches. Admin-only, and install-wide rather than
 * per account: it describes the container everyone is sharing, not a taste.
 * Switching goes and looks straight away, since the cached answer was about
 * the other channel and has just been thrown out.
 */
r.post('/channel', requireAdmin, async (req, res) => {
  const { channel } = req.body || {};
  if (!CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `Channel must be one of: ${CHANNELS.join(', ')}.` });
  }
  setChannel(channel);
  try {
    return res.json(await checkForUpdates({ force: true }));
  } catch (e) {
    console.error('update check after channel switch failed', e);
    return res.status(200).json(readStatus());
  }
});

export default r;
