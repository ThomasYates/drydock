import { Router } from 'express';
import { db, uid, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcastOp } from '../realtime.js';
import { client } from './projects.js';
import { logEvent, takeSnapshot } from '../history.js';

const r = Router();
r.use(requireAuth);

const touch = (projectId) =>
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);

function boardOr404(id, res) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  if (!board) { res.status(404).json({ error: 'No such board' }); return null; }
  return board;
}

/** Breadcrumb from root down to this board. */
function trail(board) {
  const out = [];
  let cur = board;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name, isRoot: !!cur.is_root });
    cur = cur.parent_board_id ? db.prepare('SELECT * FROM boards WHERE id = ?').get(cur.parent_board_id) : null;
  }
  return out;
}

r.get('/:id', (req, res) => {
  const board = boardOr404(req.params.id, res);
  if (!board) return;
  const items = db.prepare('SELECT * FROM items WHERE board_id = ? ORDER BY z, rowid').all(board.id);
  const imageIds = [...new Set(items.filter((i) => i.type === 'image')
    .map((i) => JSON.parse(i.data || '{}').imageId).filter(Boolean))];
  const images = imageIds.length
    ? db.prepare(`SELECT * FROM images WHERE id IN (${imageIds.map(() => '?').join(',')})`).all(...imageIds)
    : [];
  const children = db.prepare('SELECT id, name FROM boards WHERE parent_board_id = ?').all(board.id)
    .map((c) => ({
      ...c,
      thumbs: db.prepare(`
        SELECT img.thumb FROM items it
        JOIN images img ON img.id = json_extract(it.data, '$.imageId')
        WHERE it.board_id = ? AND it.type = 'image'
        ORDER BY it.z DESC LIMIT 4
      `).all(c.id).map((x) => x.thumb),
    }));
  res.json({
    board,
    trail: trail(board),
    items: items.map((i) => ({ ...i, data: JSON.parse(i.data || '{}') })),
    images,
    children,
  });
});

r.patch('/:id', (req, res) => {
  const board = boardOr404(req.params.id, res);
  if (!board) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the board a name' });
  db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, board.id);
  // keep the parent's nested-board tile label in sync
  const parentItem = db.prepare("SELECT * FROM items WHERE type = 'board' AND json_extract(data,'$.boardId') = ?").get(board.id);
  if (parentItem) {
    const data = { ...JSON.parse(parentItem.data), name };
    db.prepare('UPDATE items SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now(), parentItem.id);
    broadcastOp(`board:${parentItem.board_id}`, { kind: 'item.update', id: parentItem.id, patch: { data } }, null);
  }
  broadcastOp(`board:${board.id}`, { kind: 'board.rename', id: board.id, name }, client(req));
  logEvent(board.project_id, req.user, 'board.rename', `Renamed the board “${board.name}” to “${name}”`, { boardId: board.id });
  res.json({ board: { ...board, name } });
});

/* ---------- items ---------- */

r.post('/:id/items', (req, res) => {
  const board = boardOr404(req.params.id, res);
  if (!board) return;
  const list = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const maxZ = db.prepare('SELECT COALESCE(MAX(z), 0) z FROM items WHERE board_id = ?').get(board.id).z;
  const created = [];

  list.forEach((raw, idx) => {
    const type = ['image', 'text', 'board', 'frame'].includes(raw?.type) ? raw.type : 'text';
    const id = uid('i_');
    let data = raw.data || {};

    if (type === 'board') {
      // a nested board tile creates a real board behind it
      const childId = uid('b_');
      const name = String(data.name || 'Untitled board').trim() || 'Untitled board';
      db.prepare('INSERT INTO boards (id, project_id, parent_board_id, name, is_root, created_at) VALUES (?,?,?,?,0,?)')
        .run(childId, board.project_id, board.id, name, now());
      data = { ...data, boardId: childId, name };
    }

    db.prepare('INSERT INTO items (id, board_id, type, x, y, w, h, z, rot, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, board.id, type, num(raw.x, 0), num(raw.y, 0), num(raw.w, 320), num(raw.h, 200),
           maxZ + idx + 1, num(raw.rot, 0), JSON.stringify(data), now());
    created.push({ ...db.prepare('SELECT * FROM items WHERE id = ?').get(id), data });
  });

  touch(board.project_id);
  broadcastOp(`board:${board.id}`, { kind: 'item.create', items: created }, client(req));
  logEvent(board.project_id, req.user, 'item.create', describeAdd(created, board.name), {
    boardId: board.id, ids: created.map((i) => i.id),
  });
  res.json({ items: created });
});

r.patch('/:id/items', (req, res) => {
  const board = boardOr404(req.params.id, res);
  if (!board) return;
  const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];
  const out = [];
  const tx = db.transaction(() => {
    for (const p of patches) {
      const row = db.prepare('SELECT * FROM items WHERE id = ? AND board_id = ?').get(p.id, board.id);
      if (!row) continue;
      const data = p.data ? { ...JSON.parse(row.data || '{}'), ...p.data } : JSON.parse(row.data || '{}');
      db.prepare('UPDATE items SET x=?, y=?, w=?, h=?, z=?, rot=?, data=?, updated_at=? WHERE id=?').run(
        num(p.x, row.x), num(p.y, row.y), num(p.w, row.w), num(p.h, row.h),
        p.z === undefined ? row.z : Math.round(p.z), num(p.rot, row.rot),
        JSON.stringify(data), now(), row.id
      );
      out.push({ id: row.id, patch: { x: num(p.x, row.x), y: num(p.y, row.y), w: num(p.w, row.w), h: num(p.h, row.h), z: p.z === undefined ? row.z : Math.round(p.z), rot: num(p.rot, row.rot), data } });
    }
  });
  tx();
  touch(board.project_id);
  broadcastOp(`board:${board.id}`, { kind: 'item.patch', patches: out }, client(req));
  if (out.length) {
    const kind = classify(patches);
    const verb = kind === 'item.move' ? 'Moved' : kind === 'item.resize' ? 'Resized' : 'Edited';
    logEvent(board.project_id, req.user, kind,
      `${verb} ${out.length} item${out.length > 1 ? 's' : ''} on “${board.name}”`, { boardId: board.id });
  }
  res.json({ patches: out });
});

r.post('/:id/items/delete', (req, res) => {
  const board = boardOr404(req.params.id, res);
  if (!board) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ ids: [] });
  const rows = db.prepare(`SELECT * FROM items WHERE board_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(board.id, ...ids);

  // a big deletion gets a restore point written before anything is removed
  const nested = rows.filter((x) => x.type === 'board').length;
  if (rows.length >= 8 || nested > 0) {
    takeSnapshot(board.project_id, req.user, {
      reason: 'auto',
      label: `Before deleting ${rows.length} item${rows.length > 1 ? 's' : ''} from “${board.name}”`,
    });
  }

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (row.type === 'board') {
        const childId = JSON.parse(row.data || '{}').boardId;
        if (childId) db.prepare('DELETE FROM boards WHERE id = ?').run(childId); // cascades to its items
      }
      db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
    }
  });
  tx();
  touch(board.project_id);
  broadcastOp(`board:${board.id}`, { kind: 'item.delete', ids: rows.map((r2) => r2.id) }, client(req));
  logEvent(board.project_id, req.user, 'item.delete',
    `Deleted ${rows.length} item${rows.length > 1 ? 's' : ''}${nested ? ` (including ${nested} nested board${nested > 1 ? 's' : ''})` : ''} from “${board.name}”`,
    { boardId: board.id, count: rows.length });
  res.json({ ids: rows.map((r2) => r2.id) });
});

function describeAdd(created, boardName) {
  const tally = created.reduce((acc, i) => ({ ...acc, [i.type]: (acc[i.type] || 0) + 1 }), {});
  const parts = Object.entries(tally).map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`);
  return `Added ${parts.join(' and ')} to “${boardName}”`;
}

const POSITION_KEYS = new Set(['id', 'x', 'y', 'z']);
const SIZE_KEYS = new Set(['id', 'x', 'y', 'z', 'w', 'h']);

function classify(patches) {
  const keys = new Set(patches.flatMap((p) => Object.keys(p)));
  if ([...keys].every((k) => POSITION_KEYS.has(k))) return 'item.move';
  if ([...keys].every((k) => SIZE_KEYS.has(k))) return 'item.resize';
  return 'item.edit';
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default r;
