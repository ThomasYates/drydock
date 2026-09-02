/*
 * One search box over everything in the workspace.
 *
 * Deliberately LIKE rather than FTS5: an install of this size has thousands of
 * rows, not millions, the tables are already indexed by project, and a LIKE
 * scan finishes in single-digit milliseconds. FTS would mean a second copy of
 * every piece of text and triggers to keep it honest, which is a lot of moving
 * parts to buy nothing anyone would feel.
 */
import { db } from './db.js';

const SNIPPET_RADIUS = 70;
const PER_KIND = 12;

/**
 * `%` and `_` are wildcards to LIKE, so a search for "100%" has to escape them
 * or it matches everything. `!` is the escape character rather than the usual
 * backslash, because a backslash would have to survive a JavaScript string, a
 * template literal and SQLite, and one of those three always eats it.
 */
export function escapeLike(term) {
  return String(term).replace(/[!%_]/g, (c) => `!${c}`);
}

/** A window of text around the first match, so a hit in a long note is visible. */
export function snippet(text, term) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const at = body.toLowerCase().indexOf(String(term).toLowerCase());
  if (at < 0) return body.length > 160 ? `${body.slice(0, 160)}…` : body;

  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(body.length, at + term.length + SNIPPET_RADIUS);
  return `${from > 0 ? '…' : ''}${body.slice(from, to)}${to < body.length ? '…' : ''}`;
}

const moodboardHref = (projectId, board, itemId) => {
  const base = board.isRoot ? `/p/${projectId}/moodboard` : `/p/${projectId}/moodboard/${board.id}`;
  return itemId ? `${base}?focus=${itemId}` : base;
};

/*
 * Every query carries the same three named parameters whether it needs them or
 * not — better-sqlite3 refuses a statement handed a parameter it has no
 * placeholder for, so the project filter is written as a clause that is true
 * for everything when no project was asked for.
 */
const SCOPE = '(@projectId IS NULL OR p.id = @projectId)';

/**
 * Search every kind of thing at once. Results are capped per kind, so one
 * project with two thousand notes cannot crowd out the card that was actually
 * being looked for.
 */
export function searchAll(rawQuery, { projectId = null, limit = PER_KIND } = {}) {
  const term = String(rawQuery || '').trim();
  if (term.length < 2) return { query: term, results: [], truncated: false };

  const cap = Math.max(1, Math.min(50, Number(limit) || PER_KIND));
  const args = { like: `%${escapeLike(term)}%`, cap, projectId: projectId || null };
  const rows = (sql) => db.prepare(sql).all(args);
  const out = [];

  for (const p of rows(`
    SELECT p.id, p.name, p.summary FROM projects p
    WHERE (p.name LIKE @like ESCAPE '!' OR p.summary LIKE @like ESCAPE '!') AND ${SCOPE}
    ORDER BY p.updated_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'project', id: p.id, projectId: p.id, projectName: p.name,
      title: p.name, snippet: snippet(p.summary, term), href: `/p/${p.id}`,
    });
  }

  for (const b of rows(`
    SELECT b.id, b.name, b.is_root, p.id project_id, p.name project_name
    FROM boards b JOIN projects p ON p.id = b.project_id
    WHERE b.name LIKE @like ESCAPE '!' AND ${SCOPE}
    ORDER BY b.created_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'board', id: b.id, projectId: b.project_id, projectName: b.project_name,
      title: b.name, snippet: b.is_root ? 'Root moodboard' : 'Nested board',
      href: moodboardHref(b.project_id, { id: b.id, isRoot: !!b.is_root }),
    });
  }

  for (const it of rows(`
    SELECT i.id, json_extract(i.data, '$.text') text, b.id board_id, b.name board_name, b.is_root,
           p.id project_id, p.name project_name
    FROM items i
    JOIN boards b ON b.id = i.board_id
    JOIN projects p ON p.id = b.project_id
    WHERE i.type = 'text' AND json_extract(i.data, '$.text') LIKE @like ESCAPE '!' AND ${SCOPE}
    ORDER BY i.updated_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'note', id: it.id, projectId: it.project_id, projectName: it.project_name,
      title: it.board_name, snippet: snippet(it.text, term),
      href: moodboardHref(it.project_id, { id: it.board_id, isRoot: !!it.is_root }, it.id),
    });
  }

  for (const c of rows(`
    SELECT c.id, c.title, c.body, col.name column_name, p.id project_id, p.name project_name
    FROM cards c
    JOIN columns col ON col.id = c.column_id
    JOIN projects p ON p.id = col.project_id
    WHERE (c.title LIKE @like ESCAPE '!' OR c.body LIKE @like ESCAPE '!') AND ${SCOPE}
    ORDER BY c.updated_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'card', id: c.id, projectId: c.project_id, projectName: c.project_name,
      title: c.title, snippet: snippet(c.body || c.column_name, term),
      href: `/p/${c.project_id}/tasks?card=${c.id}`,
    });
  }

  for (const n of rows(`
    SELECT n.id, n.title, n.body, n.type, g.id graph_id, p.id project_id, p.name project_name
    FROM nodes n
    JOIN graphs g ON g.id = n.graph_id
    JOIN projects p ON p.id = g.project_id
    WHERE n.type NOT IN ('entry','exit')
      AND (n.title LIKE @like ESCAPE '!' OR n.body LIKE @like ESCAPE '!') AND ${SCOPE}
    ORDER BY n.updated_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'beat', id: n.id, projectId: n.project_id, projectName: n.project_name,
      title: n.title, snippet: snippet(n.body || n.type, term),
      href: `/p/${n.project_id}/story/${n.graph_id}?focus=${n.id}`,
    });
  }

  for (const img of rows(`
    SELECT i.id, i.original_name, p.id project_id, p.name project_name
    FROM images i JOIN projects p ON p.id = i.project_id
    WHERE i.original_name LIKE @like ESCAPE '!' AND ${SCOPE}
    ORDER BY i.created_at DESC LIMIT @cap
  `)) {
    out.push({
      kind: 'image', id: img.id, projectId: img.project_id, projectName: img.project_name,
      title: img.original_name, snippet: 'Uploaded image',
      href: `/p/${img.project_id}/assets`,
    });
  }

  return { query: term, results: out, truncated: out.length >= cap * 6 };
}
