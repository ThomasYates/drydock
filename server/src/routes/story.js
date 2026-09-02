import { Router } from 'express';
import { db, uid, now } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcastOp } from '../realtime.js';
import { client } from './projects.js';
import { logEvent, takeSnapshot } from '../history.js';

const r = Router();
r.use(requireAuth);

const room = (graphId) => `graph:${graphId}`;
const projectOf = (graphId) => db.prepare('SELECT project_id FROM graphs WHERE id = ?').get(graphId)?.project_id;
const parse = (n) => ({ ...n, data: withPorts(safe(n.data), n.type) });
function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

const NODE_TYPES = ['beat', 'dialogue', 'choice', 'condition', 'ending', 'note', 'entry', 'exit'];

/** Every node carries its own named inputs and outputs. */
function withPorts(data, type) {
  const d = { ...data };
  // a node from before configurable ports used choice `options`
  if (Array.isArray(d.options) && !d.outputs) {
    d.outputs = d.options.map((o) => ({ id: o.id, label: o.text || 'Option' }));
    delete d.options;
  }
  if (!Array.isArray(d.inputs)) d.inputs = defaultInputs(type);
  if (!Array.isArray(d.outputs)) d.outputs = defaultOutputs(type);
  return d;
}

function defaultInputs(type) {
  if (type === 'entry') return [];
  return [{ id: 'in', label: 'In' }];
}
function defaultOutputs(type) {
  if (type === 'ending' || type === 'note' || type === 'exit') return [];
  if (type === 'condition') return [{ id: 'true', label: 'If true' }, { id: 'false', label: 'Otherwise' }];
  if (type === 'choice') return [{ id: uid('o_'), label: 'Option one' }, { id: uid('o_'), label: 'Option two' }];
  return [{ id: 'out', label: 'Out' }];
}

const cleanPorts = (list, fallback) => {
  if (!Array.isArray(list)) return fallback;
  const seen = new Set();
  return list
    .filter((p) => p && typeof p.id === 'string' && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ id: p.id, label: String(p.label ?? '').slice(0, 60) || 'Port' }))
    .slice(0, 24);
};

/* ── threads ─────────────────────────────────────────────── */

r.get('/project/:projectId/graphs', (req, res) => {
  res.json({
    graphs: db.prepare(
      'SELECT * FROM graphs WHERE project_id = ? AND parent_node_id IS NULL ORDER BY position, created_at'
    ).all(req.params.projectId),
  });
});

r.post('/project/:projectId/graphs', (req, res) => {
  const pos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM graphs WHERE project_id = ?').get(req.params.projectId).p;
  const g = {
    id: uid('g_'), project_id: req.params.projectId, parent_node_id: null,
    name: String(req.body?.name || 'New thread').trim(), position: pos + 1, created_at: now(),
  };
  db.prepare('INSERT INTO graphs (id, project_id, parent_node_id, name, position, created_at) VALUES (?,?,?,?,?,?)')
    .run(g.id, g.project_id, null, g.name, g.position, g.created_at);
  logEvent(g.project_id, req.user, 'graph.create', `Started the story thread “${g.name}”`, {});
  res.json({ graph: g });
});

r.patch('/graphs/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'No such page' });
  const name = String(req.body?.name || g.name).trim() || g.name;
  db.prepare('UPDATE graphs SET name = ? WHERE id = ?').run(name, g.id);
  broadcastOp(room(g.id), { kind: 'graph.rename', id: g.id, name }, client(req));
  logEvent(g.project_id, req.user, 'graph.rename', `Renamed a story page to “${name}”`, {});
  res.json({ graph: { ...g, name } });
});

r.delete('/graphs/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'No such page' });
  if (g.parent_node_id) return res.status(400).json({ error: 'Delete the node instead — this page belongs to it' });
  const count = db.prepare('SELECT COUNT(*) c FROM graphs WHERE project_id = ? AND parent_node_id IS NULL').get(g.project_id).c;
  if (count <= 1) return res.status(400).json({ error: 'Keep at least one story thread' });
  const held = db.prepare('SELECT COUNT(*) c FROM nodes WHERE graph_id = ?').get(g.id).c;
  if (held >= 3) takeSnapshot(g.project_id, req.user, { reason: 'auto', label: `Before deleting the story thread “${g.name}”` });
  dropGraph(g.id);
  logEvent(g.project_id, req.user, 'graph.delete', `Deleted the story thread “${g.name}” and its ${held} beat${held === 1 ? '' : 's'}`, {});
  res.json({ ok: true });
});

/** Remove a page, everything on it, and any planner pages hanging off it. */
function dropGraph(graphId) {
  const kids = db.prepare(
    'SELECT id FROM graphs WHERE parent_node_id IN (SELECT id FROM nodes WHERE graph_id = ?)'
  ).all(graphId);
  for (const child of kids) dropGraph(child.id);
  db.prepare('DELETE FROM graphs WHERE id = ?').run(graphId);
}

function dropNode(node) {
  for (const child of db.prepare('SELECT id FROM graphs WHERE parent_node_id = ?').all(node.id)) dropGraph(child.id);
  db.prepare('DELETE FROM edges WHERE from_node = ? OR to_node = ?').run(node.id, node.id);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
}

/** Walk from a planner page back up to the thread it lives under. */
function trailOf(graph) {
  const trail = [];
  let cur = graph;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.parent_node_id ? db.prepare('SELECT * FROM nodes WHERE id = ?').get(cur.parent_node_id) : null;
    trail.unshift({ id: cur.id, name: parent ? parent.title : cur.name, isPlanner: !!parent });
    cur = parent ? db.prepare('SELECT * FROM graphs WHERE id = ?').get(parent.graph_id) : null;
  }
  return trail;
}

r.get('/graphs/:id', (req, res) => {
  const graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!graph) return res.status(404).json({ error: 'No such page' });
  const nodes = db.prepare('SELECT * FROM nodes WHERE graph_id = ?').all(graph.id).map(parse);
  const planned = new Set(
    db.prepare('SELECT parent_node_id FROM graphs WHERE parent_node_id IS NOT NULL').all().map((g) => g.parent_node_id)
  );
  res.json({
    graph,
    trail: trailOf(graph),
    nodes: nodes.map((n) => ({ ...n, hasPlanner: planned.has(n.id) })),
    edges: db.prepare('SELECT * FROM edges WHERE graph_id = ?').all(graph.id),
  });
});

/* ── nodes ───────────────────────────────────────────────── */

r.post('/graphs/:id/nodes', (req, res) => {
  const graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!graph) return res.status(404).json({ error: 'No such page' });
  const b = req.body || {};
  const type = NODE_TYPES.includes(b.type) && !['entry', 'exit'].includes(b.type) ? b.type : 'beat';
  const data = withPorts(b.data || {}, type);
  const node = {
    id: uid('n_'), graph_id: graph.id, type,
    title: String(b.title || 'Untitled').trim() || 'Untitled',
    body: String(b.body || ''),
    x: Number(b.x) || 0, y: Number(b.y) || 0,
    w: Number(b.w) || 280, h: Number(b.h) || 0,
    data, updated_at: now(),
  };
  db.prepare('INSERT INTO nodes (id, graph_id, type, title, body, x, y, w, h, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(node.id, node.graph_id, node.type, node.title, node.body, node.x, node.y, node.w, node.h,
         JSON.stringify(node.data), node.updated_at);
  broadcastOp(room(graph.id), { kind: 'node.create', node: { ...node, hasPlanner: false } }, client(req));
  logEvent(graph.project_id, req.user, 'node.create', `Added the ${node.type} “${node.title}”`, { nodeId: node.id });
  res.json({ node: { ...node, hasPlanner: false } });
});

r.patch('/nodes/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'No such node' });
  const b = req.body || {};
  const current = withPorts(safe(node.data), node.type);
  const type = NODE_TYPES.includes(b.type) ? b.type : node.type;

  let data = current;
  if (b.data !== undefined) {
    data = { ...current, ...b.data };
    if (b.data.inputs !== undefined) data.inputs = cleanPorts(b.data.inputs, current.inputs);
    if (b.data.outputs !== undefined) data.outputs = cleanPorts(b.data.outputs, current.outputs);
  }
  if (type !== node.type && b.data?.outputs === undefined) {
    // switching kind resets the rails to whatever that kind normally carries
    if (type === 'ending' || type === 'note') data = { ...data, outputs: [] };
    else if (!data.outputs.length) data = { ...data, outputs: defaultOutputs(type) };
  }

  const next = {
    ...node, type,
    title: b.title === undefined ? node.title : String(b.title),
    body: b.body === undefined ? node.body : String(b.body),
    x: b.x === undefined ? node.x : Number(b.x),
    y: b.y === undefined ? node.y : Number(b.y),
    w: b.w === undefined ? node.w : Math.max(180, Number(b.w)),
    h: b.h === undefined ? node.h : Math.max(0, Number(b.h)),
    data, updated_at: now(),
  };
  db.prepare('UPDATE nodes SET type=?, title=?, body=?, x=?, y=?, w=?, h=?, data=?, updated_at=? WHERE id=?')
    .run(next.type, next.title, next.body, next.x, next.y, next.w, next.h,
         JSON.stringify(next.data), next.updated_at, node.id);

  // drop any link that pointed at a port which no longer exists
  const liveIn = new Set(data.inputs.map((p) => p.id));
  const liveOut = new Set(data.outputs.map((p) => p.id));
  const orphans = db.prepare('SELECT * FROM edges WHERE from_node = ? OR to_node = ?').all(node.id, node.id)
    .filter((e) => (e.from_node === node.id && !liveOut.has(e.from_port))
                || (e.to_node === node.id && !liveIn.has(e.to_port)));
  for (const e of orphans) {
    db.prepare('DELETE FROM edges WHERE id = ?').run(e.id);
    broadcastOp(room(node.graph_id), { kind: 'edge.delete', id: e.id }, null);
  }

  syncPlanner(node.id);

  const planner = db.prepare('SELECT id FROM graphs WHERE parent_node_id = ?').get(node.id);
  const payload = { ...next, data, hasPlanner: !!planner };
  broadcastOp(room(node.graph_id), { kind: 'node.update', node: payload }, client(req));
  logEvent(projectOf(node.graph_id), req.user, 'node.update', `Edited the beat “${next.title}”`, { nodeId: node.id });
  res.json({ node: payload });
});

r.post('/nodes/move', (req, res) => {
  const moves = Array.isArray(req.body?.moves) ? req.body.moves : [];
  if (!moves.length) return res.json({ ok: true });
  const first = db.prepare('SELECT graph_id FROM nodes WHERE id = ?').get(moves[0].id);
  const tx = db.transaction(() => {
    for (const m of moves) {
      db.prepare('UPDATE nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?')
        .run(Number(m.x) || 0, Number(m.y) || 0, now(), m.id);
    }
  });
  tx();
  if (first) {
    broadcastOp(room(first.graph_id), { kind: 'node.move', moves }, client(req));
    logEvent(projectOf(first.graph_id), req.user, 'node.move',
      `Moved ${moves.length} beat${moves.length > 1 ? 's' : ''} around`, {});
  }
  res.json({ ok: true });
});

r.delete('/nodes/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'No such node' });
  if (node.type === 'entry' || node.type === 'exit') {
    return res.status(400).json({ error: 'This marker mirrors a port on the node above. Remove that port instead.' });
  }
  const planner = db.prepare('SELECT id FROM graphs WHERE parent_node_id = ?').get(node.id);
  if (planner) {
    const inside = db.prepare('SELECT COUNT(*) c FROM nodes WHERE graph_id = ?').get(planner.id).c;
    if (inside > 4) {
      takeSnapshot(projectOf(node.graph_id), req.user, {
        reason: 'auto', label: `Before deleting “${node.title}” and its planner page`,
      });
    }
  }
  dropNode(node);
  broadcastOp(room(node.graph_id), { kind: 'node.delete', id: node.id }, client(req));
  logEvent(projectOf(node.graph_id), req.user, 'node.delete', `Deleted the beat “${node.title}”`, {});
  res.json({ ok: true });
});

/* ── planner pages ───────────────────────────────────────── */

/**
 * A node can be opened up and planned out on its own page. That page always
 * holds one marker per port on the node above, so the ways in and the ways out
 * are already sitting on the canvas waiting to be joined up.
 */
function syncPlanner(nodeId) {
  const graph = db.prepare('SELECT * FROM graphs WHERE parent_node_id = ?').get(nodeId);
  if (!graph) return null;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return null;
  const data = withPorts(safe(node.data), node.type);

  const markers = db.prepare("SELECT * FROM nodes WHERE graph_id = ? AND type IN ('entry','exit')").all(graph.id).map(parse);
  const wanted = [
    ...data.inputs.map((port, i) => ({ port, type: 'entry', i })),
    ...data.outputs.map((port, i) => ({ port, type: 'exit', i })),
  ];

  for (const m of markers) {
    if (!wanted.some((w) => w.type === m.type && w.port.id === m.data.portId)) dropNode(m);
  }

  for (const w of wanted) {
    const existing = markers.find((m) => m.type === w.type && m.data.portId === w.port.id);
    if (existing) {
      if (existing.title !== w.port.label) {
        db.prepare('UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?').run(w.port.label, now(), existing.id);
      }
      continue;
    }
    const payload = w.type === 'entry'
      ? { inputs: [], outputs: [{ id: 'out', label: 'Leads to' }], portId: w.port.id }
      : { inputs: [{ id: 'in', label: 'Arrives from' }], outputs: [], portId: w.port.id };
    db.prepare('INSERT INTO nodes (id, graph_id, type, title, body, x, y, w, h, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid('n_'), graph.id, w.type, w.port.label, '', w.type === 'entry' ? 0 : 780, w.i * 150, 210, 0,
           JSON.stringify(payload), now());
  }
  db.prepare('UPDATE graphs SET name = ? WHERE id = ?').run(node.title, graph.id);
  return graph;
}

r.post('/nodes/:id/planner', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'No such node' });
  if (node.type === 'entry' || node.type === 'exit') {
    return res.status(400).json({ error: 'Markers cannot be opened up — they only mirror a port above' });
  }
  let graph = db.prepare('SELECT * FROM graphs WHERE parent_node_id = ?').get(node.id);
  if (!graph) {
    const id = uid('g_');
    const projectId = projectOf(node.graph_id);
    db.prepare('INSERT INTO graphs (id, project_id, parent_node_id, name, position, created_at) VALUES (?,?,?,?,0,?)')
      .run(id, projectId, node.id, node.title, now());
    graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(id);
    logEvent(projectId, req.user, 'planner.open', `Opened a planner page for “${node.title}”`, { nodeId: node.id });
    broadcastOp(room(node.graph_id), { kind: 'node.planner', id: node.id }, null);
  }
  syncPlanner(node.id);
  res.json({ graph: db.prepare('SELECT * FROM graphs WHERE id = ?').get(graph.id) });
});

/* ── links ───────────────────────────────────────────────── */

r.post('/graphs/:id/edges', (req, res) => {
  const graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!graph) return res.status(404).json({ error: 'No such page' });
  const { fromNode, toNode, label = '' } = req.body || {};
  // these two are the ones that get corrected below when a port has gone
  let { fromPort = 'out', toPort } = req.body || {};
  if (!fromNode || !toNode) return res.status(400).json({ error: 'Pick something to link to' });
  if (fromNode === toNode) return res.status(400).json({ error: 'A node cannot link to itself' });

  const a = db.prepare('SELECT * FROM nodes WHERE id = ? AND graph_id = ?').get(fromNode, graph.id);
  const b = db.prepare('SELECT * FROM nodes WHERE id = ? AND graph_id = ?').get(toNode, graph.id);
  if (!a || !b) return res.status(404).json({ error: 'One of those is not on this page' });

  const aData = withPorts(safe(a.data), a.type);
  const bData = withPorts(safe(b.data), b.type);
  if (!aData.outputs.some((p) => p.id === fromPort)) {
    if (!aData.outputs.length) return res.status(400).json({ error: `“${a.title}” has no way out to link from` });
    fromPort = aData.outputs[0].id;
  }
  if (!toPort || !bData.inputs.some((p) => p.id === toPort)) {
    if (!bData.inputs.length) return res.status(400).json({ error: `“${b.title}” has no way in to link to` });
    toPort = bData.inputs[0].id;
  }

  const dup = db.prepare('SELECT 1 FROM edges WHERE graph_id=? AND from_node=? AND from_port=? AND to_node=? AND to_port=?')
    .get(graph.id, fromNode, fromPort, toNode, toPort);
  if (dup) return res.status(409).json({ error: 'Those two are already joined up' });

  const edge = {
    id: uid('e_'), graph_id: graph.id,
    from_node: fromNode, from_port: fromPort, to_node: toNode, to_port: toPort, label,
  };
  db.prepare('INSERT INTO edges (id, graph_id, from_node, from_port, to_node, to_port, label) VALUES (?,?,?,?,?,?,?)')
    .run(edge.id, edge.graph_id, edge.from_node, edge.from_port, edge.to_node, edge.to_port, edge.label);
  broadcastOp(room(graph.id), { kind: 'edge.create', edge }, client(req));
  logEvent(graph.project_id, req.user, 'edge.create', `Linked “${a.title}” to “${b.title}”`, {});
  res.json({ edge });
});

r.delete('/edges/:id', (req, res) => {
  const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get(req.params.id);
  if (!edge) return res.status(404).json({ error: 'No such link' });
  db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
  broadcastOp(room(edge.graph_id), { kind: 'edge.delete', id: edge.id }, client(req));
  const a = db.prepare('SELECT title FROM nodes WHERE id = ?').get(edge.from_node)?.title;
  const b = db.prepare('SELECT title FROM nodes WHERE id = ?').get(edge.to_node)?.title;
  logEvent(projectOf(edge.graph_id), req.user, 'edge.delete', `Unlinked “${a}” from “${b}”`, {});
  res.json({ ok: true });
});

/* ── script ──────────────────────────────────────────────── */

r.get('/graphs/:id/script', (req, res) => {
  const graph = db.prepare('SELECT * FROM graphs WHERE id = ?').get(req.params.id);
  if (!graph) return res.status(404).json({ error: 'No such page' });
  const nodes = db.prepare('SELECT * FROM nodes WHERE graph_id = ?').all(graph.id).map(parse);
  const edges = db.prepare('SELECT * FROM edges WHERE graph_id = ?').all(graph.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Set(edges.map((e) => e.to_node));
  const roots = nodes.filter((n) => !incoming.has(n.id) && n.type !== 'note');
  const loose = [];

  const lines = [`# ${graph.name}`, ''];
  const walk = (id, depth, seen, prefix) => {
    const n = byId.get(id);
    if (!n) return;
    const pad = '  '.repeat(depth);
    lines.push(`${pad}${prefix}**${n.title}**  \`${n.type}\``);
    if (n.body.trim()) lines.push(`${pad}${n.body.trim().split('\n').join(`\n${pad}`)}`);

    const planner = db.prepare(
      'SELECT id, (SELECT COUNT(*) FROM nodes WHERE graph_id = graphs.id) c FROM graphs WHERE parent_node_id = ?'
    ).get(n.id);
    if (planner && planner.c > 0) {
      lines.push(`${pad}_planned out on its own page — ${planner.c} node${planner.c === 1 ? '' : 's'}_`);
    }

    if (seen.has(id)) { lines.push(`${pad}↩ loops back`); return; }

    const out = edges.filter((e) => e.from_node === id);
    const wired = new Set(out.map((e) => e.from_port));
    for (const port of n.data.outputs) {
      if (wired.has(port.id)) continue;
      lines.push(`${pad}⚠ “${port.label}” goes nowhere yet`);
      if (!loose.some((l) => l.node === n.title && l.port === port.label)) loose.push({ node: n.title, port: port.label });
    }

    const nextSeen = new Set(seen).add(id);
    for (const e of out) {
      const port = n.data.outputs.find((p) => p.id === e.from_port);
      const lbl = e.label || (port && port.id !== 'out' ? port.label : '');
      lines.push('');
      walk(e.to_node, depth + 1, nextSeen, lbl ? `→ *${lbl}* · ` : '→ ');
    }
  };

  if (!roots.length && nodes.length) lines.push('_Everything here has something pointing at it, so there is no clear way in._', '');
  roots.forEach((rt, i) => {
    if (i) lines.push('', '---', '');
    walk(rt.id, 0, new Set(), '');
  });

  if (loose.length) {
    lines.push('', '## Loose ends', '');
    loose.forEach((l) => lines.push(`- **${l.node}** — “${l.port}” is not wired up`));
  }
  const notes = nodes.filter((n) => n.type === 'note');
  if (notes.length) {
    lines.push('', '## Notes', '');
    notes.forEach((n) => lines.push(`- **${n.title}** — ${n.body.replace(/\n/g, ' ')}`));
  }
  res.type('text/markdown').send(lines.join('\n'));
});

export default r;
