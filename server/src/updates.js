/*
 * Update checking.
 *
 * Drydock runs as a container the person deploying it built or pulled, so it
 * cannot update itself — doing that would mean handing the web app the Docker
 * socket, which turns any bug in here into root on the host. What it can do is
 * notice that a newer release exists and say so, with the two commands needed
 * to take it.
 *
 * The check is one unauthenticated GET to the GitHub releases API, cached in
 * the settings table so a busy install does not hammer it, and switched off
 * entirely with UPDATE_CHECK=0.
 */
import { getSetting, setSetting } from './db.js';
import { VERSION } from './version.js';
import { isNewer } from './semver.js';

const DEFAULT_REPO = 'ThomasYates/drydock';
const NOTES_LIMIT = 12_000;
const REQUEST_TIMEOUT_MS = 10_000;

const KEY_RELEASE = 'update.release';
const KEY_CHECKED = 'update.checked_at';
const KEY_ERROR = 'update.error';
const KEY_CHANNEL = 'update.channel';

/**
 * Which line of work this install follows. `stable` watches releases, the way
 * it always has. `beta` watches the branch that things go to before they are
 * promised to anyone, and is republished on every push to it.
 *
 * This only decides what gets watched and what the notice says. Taking an
 * update is still two commands on the host — the container cannot change the
 * image it was started from, and giving it the power to would mean handing the
 * web app the Docker socket.
 */
export const CHANNELS = ['stable', 'beta'];

export function readChannel() {
  const stored = getSetting(KEY_CHANNEL);
  return CHANNELS.includes(stored) ? stored : 'stable';
}

/** Switching throws away the cached answer: it describes the other channel. */
export function setChannel(channel) {
  if (!CHANNELS.includes(channel)) return readChannel();
  if (channel !== readChannel()) {
    setSetting(KEY_CHANNEL, channel);
    setSetting(KEY_RELEASE, '');
    setSetting(KEY_CHECKED, '');
    setSetting(KEY_ERROR, '');
  }
  return channel;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An owner/name pair and nothing else — this goes straight into a URL. */
export const validRepo = (repo) => typeof repo === 'string' && REPO_RE.test(repo);

export function config() {
  const repo = String(process.env.UPDATE_REPO || DEFAULT_REPO).trim();
  const hours = Number(process.env.UPDATE_CHECK_HOURS || 6);
  return {
    enabled: process.env.UPDATE_CHECK !== '0',
    repo,
    channel: readChannel(),
    intervalMs: Math.max(1, Number.isFinite(hours) ? hours : 6) * 3_600_000,
  };
}

/**
 * Turn a GitHub release payload into the handful of fields the UI needs, or
 * null when it is not something to offer anyone: a draft, a pre-release, or a
 * tag that is not a version at all.
 */
export function normaliseRelease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.draft || raw.prerelease) return null;

  const tag = String(raw.tag_name || '').trim();
  const version = tag.replace(/^v/i, '');
  // a tag has to be a version, or there is no telling whether it is newer
  if (!/^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(version)) return null;

  const body = String(raw.body || '').trim();
  return {
    version,
    name: String(raw.name || '').trim() || tag,
    url: String(raw.html_url || '').trim(),
    notes: body.length > NOTES_LIMIT ? `${body.slice(0, NOTES_LIMIT)}…` : body,
    publishedAt: String(raw.published_at || '') || null,
  };
}

/**
 * The beta channel is one release that gets rewritten in place, tagged `beta`,
 * marked pre-release so nothing on the stable channel is ever offered it. Its
 * tag does not move with the version, so the version is the name — which the
 * workflow sets to the build it just published, commit and all.
 */
export function normaliseBeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.draft) return null;

  const version = String(raw.name || '').trim();
  if (!/^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(version)) return null;

  const body = String(raw.body || '').trim();
  return {
    version,
    name: version,
    url: String(raw.html_url || '').trim(),
    notes: body.length > NOTES_LIMIT ? `${body.slice(0, NOTES_LIMIT)}…` : body,
    publishedAt: String(raw.published_at || '') || null,
  };
}

/**
 * Ask GitHub for the newest release on a channel. Never throws: every failure
 * comes back as a sentence that can be shown to an admin as-is.
 */
export async function fetchLatestRelease(repo, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, channel = 'stable' } = {}) {
  const beta = channel === 'beta';
  if (!validRepo(repo)) {
    return { release: null, error: `“${repo}” is not a repository. Use the owner/name form.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const path = beta ? 'releases/tags/beta' : 'releases/latest';
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': `Drydock/${VERSION}`,
      },
    });

    // a repo with no release yet — or a channel with no build yet — is a normal
    // state, not a problem
    if (res.status === 404) return { release: null, error: null };
    if (res.status === 403 || res.status === 429) {
      return { release: null, error: 'GitHub rate limit reached. Try again in an hour.' };
    }
    if (!res.ok) return { release: null, error: `GitHub answered ${res.status}.` };

    const raw = await res.json();
    return { release: beta ? normaliseBeta(raw) : normaliseRelease(raw), error: null };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'it timed out' : 'the request failed';
    return { release: null, error: `Could not reach GitHub — ${reason}.` };
  } finally {
    clearTimeout(timer);
  }
}

const readJson = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/**
 * On stable, newer means a higher version. On beta that comparison is no use —
 * every build is the same version with a different commit on the end, and
 * semver says a pre-release sorts below the release it leads to. What matters
 * there is simply whether the published build is the one running.
 */
function offers(release, channel) {
  if (!release) return false;
  return channel === 'beta' ? release.version !== VERSION : isNewer(release.version, VERSION);
}

/** The cached answer, with no network access at all. */
export function readStatus() {
  const { enabled, repo, channel, intervalMs } = config();
  const release = readJson(getSetting(KEY_RELEASE));
  const checkedAt = getSetting(KEY_CHECKED) || null;
  const error = getSetting(KEY_ERROR) || null;

  return {
    enabled,
    repo,
    channel,
    current: VERSION,
    latest: release?.version || null,
    updateAvailable: enabled && offers(release, channel),
    release,
    checkedAt,
    error,
    stale: !checkedAt || Date.now() - Date.parse(checkedAt) > intervalMs,
  };
}

/**
 * Check GitHub, unless a fresh enough answer is already on file. `force` is
 * what the admin's Check for updates button sends.
 */
export async function checkForUpdates({ force = false, fetchImpl } = {}) {
  const { enabled, repo, channel, intervalMs } = config();
  if (!enabled) return readStatus();

  const checkedAt = getSetting(KEY_CHECKED);
  const fresh = checkedAt && Date.now() - Date.parse(checkedAt) < intervalMs;
  if (fresh && !force) return readStatus();

  const { release, error } = await fetchLatestRelease(repo, { channel, ...(fetchImpl ? { fetchImpl } : {}) });
  setSetting(KEY_CHECKED, new Date().toISOString());
  setSetting(KEY_ERROR, error || '');
  // a failed check keeps whatever was last known good rather than blanking it
  if (release) setSetting(KEY_RELEASE, JSON.stringify(release));

  return readStatus();
}

/**
 * Check shortly after boot, then on the configured interval. Unref'd so it
 * never holds the process open.
 */
export function startUpdatePolling() {
  const { enabled, intervalMs } = config();
  if (!enabled) return () => {};

  const run = () => {
    checkForUpdates().catch((e) => console.error('update check failed', e));
  };
  const first = setTimeout(run, 20_000);
  const repeat = setInterval(run, intervalMs);
  first.unref();
  repeat.unref();
  return () => { clearTimeout(first); clearInterval(repeat); };
}
