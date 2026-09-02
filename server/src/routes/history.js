import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import {
  logEvent, takeSnapshot, restoreSnapshot, removeSnapshot, shape, gcImageFiles,
} from '../history.js';

const r = Router();
r.use(requireAuth);

const parseCounts = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

r.get('/:projectId/events', (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 120);
  const before = req.query.before;
  const rows = before
    ? db.prepare('SELECT * FROM events WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?')
        .all(req.params.projectId, before, limit)
    : db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(req.params.projectId, limit);
  res.json({ events: rows.map(shape) });
});

r.get('/:projectId/snapshots', (req, res) => {
  const rows = db.prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC')
    .all(req.params.projectId);
  res.json({ snapshots: rows.map((s) => ({ ...s, counts: parseCounts(s.counts) })) });
});

r.post('/:projectId/snapshots', (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'No such project' });
  const label = String(req.body?.label || '').trim();
  const snap = takeSnapshot(project.id, req.user, { label: label || undefined, reason: 'manual' });
  logEvent(project.id, req.user, 'snapshot.create', `Saved a restore point${label ? `: “${label}”` : ''}`, { snapshotId: snap.id });
  res.json({ snapshot: { ...snap, counts: parseCounts(snap.counts) } });
});

r.post('/snapshots/:id/restore', requireAdmin, (req, res) => {
  const result = restoreSnapshot(req.params.id, req.user);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({
    ok: true,
    counts: result.counts,
    safetyId: result.safety?.id,
  });
});

r.delete('/snapshots/:id', requireAdmin, (req, res) => {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.params.id);
  if (!snap) return res.status(404).json({ error: 'No such restore point' });
  removeSnapshot(snap.id);
  logEvent(snap.project_id, req.user, 'snapshot.delete', `Deleted the restore point “${snap.label}”`, {});
  res.json({ ok: true });
});

r.post('/:projectId/sweep', requireAdmin, (req, res) => {
  const removed = gcImageFiles();
  res.json({ removed });
});

export default r;
