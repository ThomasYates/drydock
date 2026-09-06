import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/*
 * The server does the asking; this only reads the answer it already has. That
 * keeps GitHub out of the render path entirely — an install with no outbound
 * internet gets an error string next to the button in Admin and nothing else
 * anywhere.
 */
const POLL_MS = 30 * 60_000;
const DISMISSED_KEY = 'update-dismissed';

/**
 * Dismissal is per device rather than per account, and on purpose: the banner
 * is about the machine running the container, and the person who tucks it away
 * on their laptop has not decided anything on anyone else's behalf.
 */
export function dismissedVersion() {
  try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

export function rememberDismissal(version) {
  try { localStorage.setItem(DISMISSED_KEY, version); } catch { /* private mode */ }
}

export const UPDATE_COMMANDS = 'docker compose pull\ndocker compose up -d';

export function useUpdateStatus({ poll = true } = {}) {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(dismissedVersion);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get('/api/updates');
      setStatus(next);
      return next;
    } catch {
      // an update check is never worth an error in someone's face
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!poll) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, poll]);

  const dismiss = useCallback(() => {
    if (!status?.latest) return;
    rememberDismissal(status.latest);
    setDismissed(status.latest);
  }, [status]);

  /** Admin only: go and look right now rather than waiting for the interval. */
  const checkNow = useCallback(async () => {
    const res = await api.post('/api/updates/check');
    setStatus(res);
    return res;
  }, []);

  return {
    status,
    refresh,
    checkNow,
    dismiss,
    showBanner: !!status?.updateAvailable && status.latest !== dismissed,
  };
}
