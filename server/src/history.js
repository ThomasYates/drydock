import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, uid, now, SNAPSHOT_DIR, UPLOAD_DIR } from './db.js';
import { broadcastOp } from './realtime.js';

const COALESCE_MS = 90_000;
const COALESCING_KINDS = new Set(['item.move', 'item.resize', 'node.move']);
const AUTO_KEEP = 14;

/**
 * Record something that happened. Repeated nudges of the same kind by the same
 * person inside a minute and a half fold into one row, so dragging a board
 * around does not bury the day's real changes.
 */
export function logEvent(projectId, user, kind, summary, detail = {}) {
  if (!projectId) return null;
  const name = user?.display_name || 'Someone';

  if (COALESCING_KINDS.has(kind)) {
    const prev = db.prepare(
      `SELECT * FROM events WHERE project_id = ? AND user_id IS ? AND kind = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(projectId, user?.id ?? null, kind);
    if (prev && Date.now() - new Date(prev.created_at).getTime() < COALESCE_MS) {
      db.prepare('UPDATE events SET tally = tally + 1, summary = ?, created_at = ? WHERE id = ?')
        .run(summary, now(), prev.id);
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(prev.id);
      broadcastOp(`project:${projectId}`, { kind: 'history.event', event: shape(row) }, null);
      return row.id;
    }
  }

  const id = uid('ev_');
  db.prepare(
    `INSERT INTO events (id, project_id, user_id, user_name, kind, summary, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, projectId, user?.id ?? null, name, kind, summary, JSON.stringify(detail), now());
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  broadcastOp(`project:${projectId}`, { kind: 'history.event', event: shape(row) }, null);
  return id;
}

export const shape = (row) => ({ ...row, detail: safe(row.detail) });
function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/** Everything belonging to one project, as plain data. */
export function dump(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const boards = q('SELECT * FROM boards WHERE project_id = ?', projectId);
  const columns = q('SELECT * FROM columns WHERE project_id = ?', projectId);
  const graphs = q('SELECT * FROM graphs WHERE project_id = ?', projectId);
  const ids = (rows) => rows.map((r) => r.id);
  const inList = (rows) => (rows.length ? rows.map(() => '?').join(',') : "''");
  return {
    version: 1,
    takenAt: now(),
    project,
    boards,
    items: boards.length ? q(`SELECT * FROM items WHERE board_id IN (${inList(boards)})`, ...ids(boards)) : [],
    images: q('SELECT * FROM images WHERE project_id = ?', projectId),
    columns,
    cards: columns.length ? q(`SELECT * FROM cards WHERE column_id IN (${inList(columns)})`, ...ids(columns)) : [],
    graphs,
    nodes: graphs.length ? q(`SELECT * FROM nodes WHERE graph_id IN (${inList(graphs)})`, ...ids(graphs)) : [],
    edges: graphs.length ? q(`SELECT * FROM edges WHERE graph_id IN (${inList(graphs)})`, ...ids(graphs)) : [],
  };
}

const countsOf = (d) => ({
  boards: d.boards.length, items: d.items.length, images: d.images.length,
  cards: d.cards.length, nodes: d.nodes.length, edges: d.edges.length,
});

/** Write a restore point. `reason` is one of manual | auto | pre-restore. */
export function takeSnapshot(projectId, user, { label, reason = 'manual' } = {}) {
  const data = dump(projectId);
  if (!data) return null;
  const id = uid('sn_');
  const file = `${id}.json.gz`;
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 6 });
  fs.writeFileSync(path.join(SNAPSHOT_DIR, file), buf);

  const counts = countsOf(data);
  db.prepare(
    `INSERT INTO snapshots (id, project_id, label, reason, created_by, created_by_name, file, bytes, counts, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, projectId, label || defaultLabel(reason, counts), reason,
        user?.id ?? null, user?.display_name || 'Drydock', file, buf.length, JSON.stringify(counts), now());

  if (reason === 'auto') pruneAuto(projectId);
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
}

function defaultLabel(reason, c) {
  if (reason === 'pre-restore') return 'Safety copy taken before a restore';
  if (reason === 'auto') return 'Automatic restore point';
  return `${c.items} board items · ${c.cards} cards · ${c.nodes} beats`;
}

function pruneAuto(projectId) {
  const olds = db.prepare(
    `SELECT * FROM snapshots WHERE project_id = ? AND reason = 'auto'
     ORDER BY created_at DESC LIMIT -1 OFFSET ?`
  ).all(projectId, AUTO_KEEP);
  for (const s of olds) removeSnapshot(s.id, { gc: false });
  if (olds.length) gcImageFiles();
}

export function removeSnapshot(id, { gc = true } = {}) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!snap) return false;
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  try { fs.unlinkSync(path.join(SNAPSHOT_DIR, snap.file)); } catch {}
  if (gc) gcImageFiles();
  return true;
}

export function readSnapshot(snap) {
  const raw = fs.readFileSync(path.join(SNAPSHOT_DIR, snap.file));
  return JSON.parse(zlib.gunzipSync(raw).toString());
}

/**
 * Put a project back the way it was. Always leaves a safety copy behind first,
 * so a restore can itself be undone.
 */
export function restoreSnapshot(snapshotId, user) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!snap) return { error: 'No such restore point' };
  const data = readSnapshot(snap);
  const projectId = snap.project_id;

  const safety = takeSnapshot(projectId, user, {
    reason: 'pre-restore',
    label: `Safety copy from just before restoring “${snap.label}”`,
  });

  const insert = (table, rows) => {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const row of rows) stmt.run(...cols.map((c) => row[c]));
  };

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM boards WHERE project_id = ?').run(projectId);   // cascades items
    db.prepare('DELETE FROM columns WHERE project_id = ?').run(projectId);  // cascades cards
    db.prepare('DELETE FROM graphs WHERE project_id = ?').run(projectId);   // cascades nodes + edges
    db.prepare('DELETE FROM images WHERE project_id = ?').run(projectId);

    db.prepare('UPDATE projects SET name = ?, summary = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(data.project.name, data.project.summary, data.project.status, now(), projectId);

    // parents before children
    insert('boards', [...data.boards].sort((a, b) => (a.parent_board_id ? 1 : 0) - (b.parent_board_id ? 1 : 0)));
    insert('items', data.items);
    insert('images', data.images);
    insert('columns', data.columns);
    insert('cards', data.cards);
    insert('graphs', data.graphs);
    insert('nodes', data.nodes);
    insert('edges', data.edges);
  });

  try { tx(); } catch (e) {
    return { error: `Restore failed and nothing was changed: ${e.message}` };
  }

  const counts = countsOf(data);
  logEvent(projectId, user, 'project.restore',
    `Restored the project to “${snap.label}”`,
    { snapshotId: snap.id, snapshotAt: snap.created_at, safetyId: safety?.id, counts });

  broadcastOp(`project:${projectId}`, { kind: 'project.restored', snapshotId: snap.id }, null);
  return { ok: true, snapshot: snap, safety, counts };
}

/**
 * Uploaded files are kept while any snapshot still refers to them, so a restore
 * can bring a deleted image back. Anything nothing points at gets swept up.
 */
export function gcImageFiles() {
  const keep = new Set();
  for (const row of db.prepare('SELECT file, thumb FROM images').all()) {
    keep.add(row.file); keep.add(row.thumb);
  }
  for (const snap of db.prepare('SELECT * FROM snapshots').all()) {
    try {
      for (const img of readSnapshot(snap).images || []) { keep.add(img.file); keep.add(img.thumb); }
    } catch {}
  }
  let removed = 0;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (keep.has(name)) continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); removed += 1; } catch {}
  }
  return removed;
}

/** True when a project still has a snapshot that could need this file. */
export function fileIsProtected(projectId) {
  return !!db.prepare('SELECT 1 FROM snapshots WHERE project_id = ? LIMIT 1').get(projectId);
}

/** Nightly safety net: one restore point a day for anything that changed. */
export function dailySnapshots() {
  const cutoff = new Date(Date.now() - 20 * 3600_000).toISOString();
  const projects = db.prepare('SELECT * FROM projects WHERE updated_at > ?').all(cutoff);
  for (const p of projects) {
    const last = db.prepare(
      "SELECT created_at FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(p.id);
    if (last && last.created_at > cutoff) continue;
    takeSnapshot(p.id, null, { reason: 'auto' });
  }
}
