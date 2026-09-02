import { Router } from 'express';
import { db, uid, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcastOp } from '../realtime.js';
import { client } from './projects.js';
import { logEvent, takeSnapshot } from '../history.js';

const r = Router();
r.use(requireAuth);

const room = (projectId) => `kanban:${projectId}`;
const touch = (id) => db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);

const TAG_LIMIT = 12;
const CHECKLIST_LIMIT = 60;

/** Tags are free text, so they get trimmed, de-duplicated and capped. */
function cleanTags(value, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  return value
    .map((t) => String(t).trim().slice(0, 32))
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, TAG_LIMIT);
}

/**
 * A checklist is a list of { id, text, done }. Ids come from the browser so an
 * item can be ticked without a round trip, which means they have to be checked
 * here rather than trusted.
 */
function cleanChecklist(value, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  return value
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: /^[A-Za-z0-9_-]{1,32}$/.test(String(row.id || '')) ? String(row.id) : uid('t_'),
      text: String(row.text ?? '').slice(0, 300),
      done: !!row.done,
    }))
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .slice(0, CHECKLIST_LIMIT);
}

/** An assignee has to be a real, enabled account — or nobody. */
function cleanAssignee(value, fallback = null) {
  if (value === undefined) return fallback;
  if (!value) return null;
  const found = db.prepare('SELECT id FROM users WHERE id = ? AND disabled = 0').get(String(value));
  return found ? found.id : null;
}

/** A date, or nothing. Anything else would end up rendered as-is on a card. */
function cleanDue(value, fallback = null) {
  if (value === undefined) return fallback;
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)) ? text : null;
}

const shapeCard = (row) => ({
  ...row,
  tags: safe(row.tags, []),
  checklist: safe(row.checklist, []),
});

r.get('/:projectId', (req, res) => {
  const columns = db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(req.params.projectId);
  const cards = columns.length
    ? db.prepare(`SELECT * FROM cards WHERE column_id IN (${columns.map(() => '?').join(',')}) ORDER BY position`)
        .all(...columns.map((c) => c.id))
    : [];
  res.json({ columns, cards: cards.map(shapeCard) });
});

r.post('/:projectId/columns', (req, res) => {
  const pos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM columns WHERE project_id = ?').get(req.params.projectId).p;
  const col = { id: uid('c_'), project_id: req.params.projectId, name: String(req.body?.name || 'New column').trim(), position: pos + 1000, wip_limit: null };
  db.prepare('INSERT INTO columns (id, project_id, name, position) VALUES (?,?,?,?)').run(col.id, col.project_id, col.name, col.position);
  broadcastOp(room(col.project_id), { kind: 'column.create', column: col }, client(req));
  logEvent(col.project_id, req.user, 'column.create', `Added the column “${col.name}”`, {});
  res.json({ column: col });
});

r.patch('/columns/:id', (req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'No such column' });
  const name = req.body?.name === undefined ? col.name : String(req.body.name).trim() || col.name;
  const position = req.body?.position === undefined ? col.position : Number(req.body.position);
  const wip = req.body?.wipLimit === undefined ? col.wip_limit : (req.body.wipLimit || null);
  db.prepare('UPDATE columns SET name=?, position=?, wip_limit=? WHERE id=?').run(name, position, wip, col.id);
  const next = { ...col, name, position, wip_limit: wip };
  broadcastOp(room(col.project_id), { kind: 'column.update', column: next }, client(req));
  res.json({ column: next });
});

r.delete('/columns/:id', (req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'No such column' });
  const held = db.prepare('SELECT COUNT(*) c FROM cards WHERE column_id = ?').get(col.id).c;
  if (held >= 5) {
    takeSnapshot(col.project_id, req.user, {
      reason: 'auto',
      label: `Before deleting the column “${col.name}” and its ${held} cards`,
    });
  }
  db.prepare('DELETE FROM columns WHERE id = ?').run(col.id);
  broadcastOp(room(col.project_id), { kind: 'column.delete', id: col.id }, client(req));
  logEvent(col.project_id, req.user, 'column.delete',
    `Deleted the column “${col.name}”${held ? ` and its ${held} card${held > 1 ? 's' : ''}` : ''}`, {});
  res.json({ ok: true });
});

r.post('/columns/:id/cards', (req, res) => {
  const col = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'No such column' });
  const pos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM cards WHERE column_id = ?').get(col.id).p;
  const t = now();
  const card = {
    id: uid('k_'), column_id: col.id,
    title: String(req.body?.title || 'New card').trim().slice(0, 300) || 'New card',
    body: String(req.body?.body || ''), position: pos + 1000,
    tags: cleanTags(req.body?.tags, []),
    due: cleanDue(req.body?.due), assignee: cleanAssignee(req.body?.assignee),
    checklist: cleanChecklist(req.body?.checklist, []),
    created_at: t, updated_at: t,
  };
  db.prepare(`INSERT INTO cards (id, column_id, title, body, position, tags, due, assignee, checklist, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(card.id, card.column_id, card.title, card.body, card.position, JSON.stringify(card.tags),
         card.due, card.assignee, JSON.stringify(card.checklist), t, t);
  touch(col.project_id);
  broadcastOp(room(col.project_id), { kind: 'card.create', card }, client(req));
  logEvent(col.project_id, req.user, 'card.create', `Added the card “${card.title}” to ${col.name}`, { cardId: card.id });
  res.json({ card });
});

r.patch('/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'No such card' });
  const b = req.body || {};

  // moving a card has to land it in a column of this same project, or a card
  // could be flung into someone else's board by id
  let columnId = card.column_id;
  if (b.columnId && b.columnId !== card.column_id) {
    const from = db.prepare('SELECT project_id FROM columns WHERE id = ?').get(card.column_id);
    const into = db.prepare('SELECT project_id FROM columns WHERE id = ?').get(b.columnId);
    if (!into) return res.status(404).json({ error: 'No such column' });
    if (!from || into.project_id !== from.project_id) {
      return res.status(400).json({ error: 'A card can only move within its own project' });
    }
    columnId = into ? b.columnId : card.column_id;
  }

  const next = {
    ...card,
    column_id: columnId,
    title: b.title === undefined ? card.title : String(b.title).trim().slice(0, 300) || 'Untitled',
    body: b.body === undefined ? card.body : String(b.body),
    position: b.position === undefined ? card.position : Number(b.position),
    tags: cleanTags(b.tags, safe(card.tags, [])),
    due: cleanDue(b.due, card.due),
    assignee: cleanAssignee(b.assignee, card.assignee),
    checklist: cleanChecklist(b.checklist, safe(card.checklist, [])),
    updated_at: now(),
  };
  db.prepare(`UPDATE cards SET column_id=?, title=?, body=?, position=?, tags=?, due=?, assignee=?, checklist=?, updated_at=?
              WHERE id=?`)
    .run(next.column_id, next.title, next.body, next.position, JSON.stringify(next.tags),
         next.due, next.assignee, JSON.stringify(next.checklist), next.updated_at, card.id);
  const projectId = db.prepare('SELECT project_id FROM columns WHERE id = ?').get(next.column_id)?.project_id;
  if (projectId) {
    touch(projectId);
    broadcastOp(room(projectId), { kind: 'card.update', card: next }, client(req));
    const moved = next.column_id !== card.column_id;
    const target = moved ? db.prepare('SELECT name FROM columns WHERE id = ?').get(next.column_id)?.name : null;
    logEvent(projectId, req.user, moved ? 'card.move' : 'card.update',
      moved ? `Moved “${next.title}” to ${target}` : `Edited the card “${next.title}”`, { cardId: card.id });
  }
  res.json({ card: next });
});

r.delete('/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'No such card' });
  const projectId = db.prepare('SELECT project_id FROM columns WHERE id = ?').get(card.column_id)?.project_id;
  db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  if (projectId) {
    broadcastOp(room(projectId), { kind: 'card.delete', id: card.id }, client(req));
    logEvent(projectId, req.user, 'card.delete', `Deleted the card “${card.title}”`, {});
  }
  res.json({ ok: true });
});

function safe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export default r;
