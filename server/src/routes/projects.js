import { Router } from 'express';
import { db, uid, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcastOp } from '../realtime.js';
import { logEvent } from '../history.js';

const r = Router();
r.use(requireAuth);

export const client = (req) => req.get('x-client-id') || null;

const DEFAULT_COLUMNS = ['Backlog', 'Designing', 'Building', 'Playtest', 'Shipped'];

const STARTER_NODES = [
  { type: 'beat', title: 'Cold open', body: 'Where we meet the world before anything breaks.', x: 0, y: 0 },
  { type: 'beat', title: 'Inciting incident', body: '', x: 360, y: 0 },
  { type: 'choice', title: 'First real choice', body: '', x: 720, y: -40,
    data: {
      inputs: [{ id: 'in', label: 'In' }],
      outputs: [{ id: 'o1', label: 'Trust it' }, { id: 'o2', label: 'Walk away' }],
    } },
];

function scaffold(projectId) {
  const t = now();
  const boardId = uid('b_');
  db.prepare('INSERT INTO boards (id, project_id, parent_board_id, name, is_root, created_at) VALUES (?,?,?,?,1,?)')
    .run(boardId, projectId, null, 'Moodboard', t);

  DEFAULT_COLUMNS.forEach((name, i) => {
    db.prepare('INSERT INTO columns (id, project_id, name, position) VALUES (?,?,?,?)')
      .run(uid('c_'), projectId, name, (i + 1) * 1000);
  });

  const graphId = uid('g_');
  db.prepare('INSERT INTO graphs (id, project_id, parent_node_id, name, position, created_at) VALUES (?,?,NULL,?,0,?)')
    .run(graphId, projectId, 'Main story', t);

  const ids = STARTER_NODES.map((n) => {
    const id = uid('n_');
    const ports = n.data || {
      inputs: [{ id: 'in', label: 'In' }],
      outputs: [{ id: 'out', label: 'Out' }],
    };
    db.prepare('INSERT INTO nodes (id, graph_id, type, title, body, x, y, w, h, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, graphId, n.type, n.title, n.body, n.x, n.y, 280, 0, JSON.stringify(ports), t);
    return id;
  });
  const link = db.prepare('INSERT INTO edges (id, graph_id, from_node, from_port, to_node, to_port, label) VALUES (?,?,?,?,?,?,?)');
  link.run(uid('e_'), graphId, ids[0], 'out', ids[1], 'in', '');
  link.run(uid('e_'), graphId, ids[1], 'out', ids[2], 'in', '');

  db.prepare('INSERT INTO cards (id, column_id, title, body, position, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(
      uid('k_'),
      db.prepare('SELECT id FROM columns WHERE project_id = ? ORDER BY position LIMIT 1').get(projectId).id,
      'Pin down the one-line pitch',
      'What is this game in a single sentence a stranger would repeat?',
      1000, '["design"]', t, t
    );

  return { boardId, graphId };
}

r.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT id FROM boards WHERE project_id = p.id AND is_root = 1) AS root_board_id,
      (SELECT thumb FROM images WHERE id = p.cover_image_id) AS cover_thumb,
      (SELECT COUNT(*) FROM images WHERE project_id = p.id) AS image_count,
      (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS card_count,
      (SELECT COUNT(*) FROM nodes n JOIN graphs g ON g.id = n.graph_id WHERE g.project_id = p.id) AS node_count,
      (SELECT COUNT(*) FROM boards WHERE project_id = p.id) AS board_count
    FROM projects p ORDER BY p.updated_at DESC
  `).all();
  res.json({ projects: rows });
});

r.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the project a name' });
  const id = uid('p_');
  const t = now();
  db.prepare('INSERT INTO projects (id, name, summary, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, name, String(req.body?.summary || '').trim(), req.user.id, t, t);
  const { boardId } = scaffold(id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  logEvent(id, req.user, 'project.create', `Created the project “${name}”`, {});
  res.json({ project: { ...project, root_board_id: boardId } });
});

r.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'No such project' });
  const cover = project.cover_image_id
    ? db.prepare('SELECT * FROM images WHERE id = ?').get(project.cover_image_id)
    : null;
  const boards = db.prepare('SELECT * FROM boards WHERE project_id = ? ORDER BY created_at').all(project.id);
  // top-level threads only. A planner page is a graph too, but it belongs to
  // the node it hangs off rather than to the project's list of threads —
  // /api/story/project/:id/graphs draws the same line.
  const graphs = db.prepare(
    'SELECT * FROM graphs WHERE project_id = ? AND parent_node_id IS NULL ORDER BY position, created_at'
  ).all(project.id);
  res.json({ project: { ...project, cover }, boards, graphs, rootBoardId: boards.find((b) => b.is_root)?.id });
});

r.patch('/:id', (req, res) => {
  const { name, summary, status, coverImageId } = req.body || {};
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'No such project' });

  if (coverImageId !== undefined) {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Only an admin can set the project cover' });
    if (coverImageId === null) {
      db.prepare('UPDATE projects SET cover_image_id = NULL WHERE id = ?').run(project.id);
      logEvent(project.id, req.user, 'project.cover', 'Cleared the project cover', {});
    } else {
      const image = db.prepare('SELECT * FROM images WHERE id = ? AND project_id = ?').get(coverImageId, project.id);
      if (!image) return res.status(404).json({ error: 'That image is not in this project' });
      db.prepare('UPDATE projects SET cover_image_id = ? WHERE id = ?').run(image.id, project.id);
      logEvent(project.id, req.user, 'project.cover', `Set the cover to “${image.original_name}”`, {});
    }
  }
  db.prepare('UPDATE projects SET name = COALESCE(?, name), summary = COALESCE(?, summary), status = COALESCE(?, status), updated_at = ? WHERE id = ?')
    .run(name?.trim() ?? null, summary ?? null, status ?? null, now(), project.id);
  const next = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  next.cover = next.cover_image_id
    ? db.prepare('SELECT * FROM images WHERE id = ?').get(next.cover_image_id)
    : null;
  broadcastOp(`project:${project.id}`, { kind: 'project.update', project: next }, client(req));
  logEvent(project.id, req.user, 'project.update', 'Updated the project details', {});
  res.json({ project: next });
});

/*
 * There is deliberately no way to delete a project over HTTP. It is the one
 * thing in here that cannot be undone from the History tab, so it lives behind
 * shell access instead:
 *
 *   docker exec -it drydock node src/cli.js delete-project
 */

export default r;
