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

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An owner/name pair and nothing else — this goes straight into a URL. */
export const validRepo = (repo) => typeof repo === 'string' && REPO_RE.test(repo);

export function config() {
  const repo = String(process.env.UPDATE_REPO || DEFAULT_REPO).trim();
  const hours = Number(process.env.UPDATE_CHECK_HOURS || 6);
  return {
    enabled: process.env.UPDATE_CHECK !== '0',
    repo,
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
 * Ask GitHub for the newest release. Never throws: every failure comes back as
 * a sentence that can be shown to an admin as-is.
 */
export async function fetchLatestRelease(repo, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!validRepo(repo)) {
    return { release: null, error: `“${repo}” is not a repository. Use the owner/name form.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': `Drydock/${VERSION}`,
      },
    });

    // a repo that has not cut a release yet is a normal state, not a problem
    if (res.status === 404) return { release: null, error: null };
    if (res.status === 403 || res.status === 429) {
      return { release: null, error: 'GitHub rate limit reached. Try again in an hour.' };
    }
    if (!res.ok) return { release: null, error: `GitHub answered ${res.status}.` };

    return { release: normaliseRelease(await res.json()), error: null };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'it timed out' : 'the request failed';
    return { release: null, error: `Could not reach GitHub — ${reason}.` };
  } finally {
    clearTimeout(timer);
  }
}

const readJson = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/** The cached answer, with no network access at all. */
export function readStatus() {
  const { enabled, repo, intervalMs } = config();
  const release = readJson(getSetting(KEY_RELEASE));
  const checkedAt = getSetting(KEY_CHECKED);
  const error = getSetting(KEY_ERROR) || null;

  return {
    enabled,
    repo,
    current: VERSION,
    latest: release?.version || null,
    updateAvailable: enabled && !!release && isNewer(release.version, VERSION),
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
  const { enabled, repo, intervalMs } = config();
  if (!enabled) return readStatus();

  const checkedAt = getSetting(KEY_CHECKED);
  const fresh = checkedAt && Date.now() - Date.parse(checkedAt) < intervalMs;
  if (fresh && !force) return readStatus();

  const { release, error } = await fetchLatestRelease(repo, fetchImpl ? { fetchImpl } : {});
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
