import { useEffect, useState } from 'react';
import { api } from './api.js';

/*
 * Everyone on the install, for the places that need to put a name against
 * something. Cached for the life of the page: accounts are admin-created and
 * change perhaps twice a year, so refetching on every card that opens would be
 * a request nobody asked for.
 */
let cache = null;
let inflight = null;

export async function loadMembers() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.get('/api/auth/members')
      .then((r) => { cache = r.members; return cache; })
      .catch(() => [])
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cache after an account is added or removed. */
export function forgetMembers() {
  cache = null;
}

export function useMembers() {
  const [members, setMembers] = useState(cache || []);

  useEffect(() => {
    let live = true;
    loadMembers().then((rows) => { if (live) setMembers(rows); });
    return () => { live = false; };
  }, []);

  return members;
}

export const memberName = (members, id) =>
  (id ? members.find((m) => m.id === id)?.displayName || null : null);

export const memberAccent = (members, id) =>
  (id ? members.find((m) => m.id === id)?.accent || 'var(--panel-3)' : 'var(--panel-3)');
