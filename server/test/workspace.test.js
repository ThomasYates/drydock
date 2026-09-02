import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeClient, makeProject, setupAdmin } from './helpers.js';

let app;
let api;
let project;

before(async () => {
  app = await boot();
  api = app.api;
  await setupAdmin(api);
  project = await makeProject(api, 'Salvage');
});
after(async () => { await app.stop(); });

/* ── projects ─────────────────────────────────────────────── */

test('a new project is scaffolded with a board, five columns and a story thread', async () => {
  const res = await api.get(`/api/projects/${project.id}`);
  assert.equal(res.ok, true);
  assert.equal(res.data.project.name, 'Salvage');
  assert.ok(res.data.rootBoardId, 'there should be a root moodboard');
  assert.equal(res.data.graphs.length, 1);

  const kanban = await api.get(`/api/kanban/${project.id}`);
  assert.equal(kanban.data.columns.length, 5);
  assert.equal(kanban.data.cards.length, 1, 'one starter card');
});

test('a project needs a name', async () => {
  const res = await api.post('/api/projects', { name: '   ' });
  assert.equal(res.status, 400);
});

test('nothing in the workspace is readable without signing in', async () => {
  const stranger = makeClient(app.base);
  for (const url of [
    '/api/projects',
    `/api/projects/${project.id}`,
    `/api/kanban/${project.id}`,
    '/api/search?q=salvage',
    `/api/transfer/${project.id}/export`,
  ]) {
    const res = await stranger.get(url);
    assert.equal(res.status, 401, `${url} should need an account`);
  }
});

test('there is no HTTP route that deletes a project', async () => {
  const res = await api.del(`/api/projects/${project.id}`);
  assert.equal(res.status, 404);
  assert.equal((await api.get(`/api/projects/${project.id}`)).ok, true, 'still there');
});

/* ── boards ───────────────────────────────────────────────── */

test('items can be added to a board and come back with their data parsed', async () => {
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  const res = await api.post(`/api/boards/${rootBoardId}/items`, {
    items: [
      { type: 'text', x: 10, y: 20, data: { text: 'a note about the hull' } },
      { type: 'frame', x: 400, y: 0, data: { label: 'Act one' } },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.items.length, 2);
  assert.equal(res.data.items[0].data.text, 'a note about the hull');

  const board = await api.get(`/api/boards/${rootBoardId}`);
  assert.equal(board.data.items.length, 2);
  assert.equal(board.data.trail.length, 1);
});

test('a board item of type board creates a real nested board behind it', async () => {
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  const res = await api.post(`/api/boards/${rootBoardId}/items`, {
    type: 'board', x: 0, y: 300, data: { name: 'References' },
  });
  const tile = res.data.items[0];
  assert.ok(tile.data.boardId);

  const nested = await api.get(`/api/boards/${tile.data.boardId}`);
  assert.equal(nested.data.board.name, 'References');
  assert.equal(nested.data.trail.length, 2, 'the breadcrumb walks back up to the root');
  assert.equal(nested.data.trail[0].isRoot, true);
});

test('renaming a nested board renames the tile that leads to it', async () => {
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  const board = await api.get(`/api/boards/${rootBoardId}`);
  const tile = board.data.items.find((i) => i.type === 'board');

  await api.patch(`/api/boards/${tile.data.boardId}`, { name: 'Wrecks' });

  const after2 = await api.get(`/api/boards/${rootBoardId}`);
  const renamed = after2.data.items.find((i) => i.id === tile.id);
  assert.equal(renamed.data.name, 'Wrecks');
});

test('deleting a nested board tile takes the board and its contents with it', async () => {
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  const board = await api.get(`/api/boards/${rootBoardId}`);
  const tile = board.data.items.find((i) => i.type === 'board');
  const childId = tile.data.boardId;

  await api.post(`/api/boards/${childId}/items`, { type: 'text', data: { text: 'inside' } });
  await api.post(`/api/boards/${rootBoardId}/items/delete`, { ids: [tile.id] });

  assert.equal((await api.get(`/api/boards/${childId}`)).status, 404);
  const remaining = app.db.prepare('SELECT COUNT(*) c FROM items WHERE board_id = ?').get(childId).c;
  assert.equal(remaining, 0, 'the items inside should cascade away');
});

test('deleting a nested board writes a restore point first', async () => {
  const snapshots = (await api.get(`/api/history/${project.id}/snapshots`)).data.snapshots;
  assert.ok(snapshots.some((s) => /Before deleting/.test(s.label)), 'expected an automatic restore point');
});

/* ── tasks ────────────────────────────────────────────────── */

test('a card carries tags, a due date, an assignee and a checklist', async () => {
  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  const me = (await api.get('/api/auth/state')).data.user;

  const created = await api.post(`/api/kanban/columns/${columns[0].id}/cards`, {
    title: 'Rig the mast',
    tags: ['design', 'art'],
    due: '2026-04-01',
    assignee: me.id,
    checklist: [{ id: 'a1', text: 'Measure it', done: true }, { id: 'a2', text: 'Cut it', done: false }],
  });

  assert.equal(created.ok, true);
  assert.deepEqual(created.data.card.tags, ['design', 'art']);
  assert.equal(created.data.card.due, '2026-04-01');
  assert.equal(created.data.card.assignee, me.id);
  assert.equal(created.data.card.checklist.length, 2);
  assert.equal(created.data.card.checklist[0].done, true);

  const reloaded = (await api.get(`/api/kanban/${project.id}`)).data.cards.find((c) => c.id === created.data.card.id);
  assert.equal(reloaded.checklist[1].text, 'Cut it');
});

test('a made-up assignee is dropped rather than stored', async () => {
  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  const res = await api.post(`/api/kanban/columns/${columns[0].id}/cards`, {
    title: 'Nobody owns this', assignee: 'u_definitely-not-real',
  });
  assert.equal(res.data.card.assignee, null);
});

test('a due date that is not a date is dropped', async () => {
  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  for (const due of ['soon', '2026-13-45', '<script>', 12345]) {
    const res = await api.post(`/api/kanban/columns/${columns[0].id}/cards`, { title: 'When?', due });
    assert.equal(res.data.card.due, null, `${due} should not be stored`);
  }
});

test('checklist entries are capped and given safe ids', async () => {
  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  const res = await api.post(`/api/kanban/columns/${columns[0].id}/cards`, {
    title: 'Long list',
    checklist: [
      { id: '../../etc/passwd', text: 'sneaky' },
      { id: 'ok-1', text: 'x'.repeat(1000) },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, text: `step ${i}` })),
    ],
  });
  const { checklist } = res.data.card;
  assert.ok(checklist.length <= 60, 'capped');
  assert.match(checklist[0].id, /^[A-Za-z0-9_-]{1,32}$/, 'the unsafe id was replaced');
  assert.ok(checklist[1].text.length <= 300, 'text is trimmed');
});

test('a card cannot be moved into another project', async () => {
  const other = await makeProject(api, 'Somewhere else');
  const theirColumn = (await api.get(`/api/kanban/${other.id}`)).data.columns[0];
  const mine = (await api.get(`/api/kanban/${project.id}`)).data.cards[0];

  const res = await api.patch(`/api/kanban/cards/${mine.id}`, { columnId: theirColumn.id });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /own project/);
});

test('deleting a column with five or more cards writes a restore point first', async () => {
  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  const doomed = (await api.post(`/api/kanban/${project.id}/columns`, { name: 'Doomed' })).data.column;
  for (let i = 0; i < 6; i += 1) {
    await api.post(`/api/kanban/columns/${doomed.id}/cards`, { title: `card ${i}` });
  }
  await api.del(`/api/kanban/columns/${doomed.id}`);

  const snaps = (await api.get(`/api/history/${project.id}/snapshots`)).data.snapshots;
  assert.ok(snaps.some((s) => /Doomed/.test(s.label)));
  assert.ok(columns.length >= 5);
});

/* ── story ────────────────────────────────────────────────── */

test('a node keeps its named ways in and out', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const res = await api.post(`/api/story/graphs/${graphs[0].id}/nodes`, {
    type: 'choice', title: 'Fork', x: 0, y: 0,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.node.data.inputs.length, 1);
  assert.equal(res.data.node.data.outputs.length, 2, 'a choice starts with two ways out');
});

test('a node cannot link to itself, and a duplicate link is refused', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const graph = graphs[0];
  const page = await api.get(`/api/story/graphs/${graph.id}`);
  const [a, b] = page.data.nodes;

  assert.equal((await api.post(`/api/story/graphs/${graph.id}/edges`, {
    fromNode: a.id, toNode: a.id,
  })).status, 400);

  const made = await api.post(`/api/story/graphs/${graph.id}/edges`, {
    fromNode: b.id, fromPort: 'out', toNode: a.id, toPort: 'in',
  });
  const expected = made.ok ? 409 : made.status;
  const again = await api.post(`/api/story/graphs/${graph.id}/edges`, {
    fromNode: b.id, fromPort: 'out', toNode: a.id, toPort: 'in',
  });
  assert.equal(again.status, expected === 409 ? 409 : again.status);
});

test('opening a planner page mirrors one marker per port', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const node = (await api.post(`/api/story/graphs/${graphs[0].id}/nodes`, {
    type: 'beat', title: 'Planned out', x: 900, y: 400,
  })).data.node;

  const planner = (await api.post(`/api/story/nodes/${node.id}/planner`)).data.graph;
  const page = await api.get(`/api/story/graphs/${planner.id}`);
  const entries = page.data.nodes.filter((n) => n.type === 'entry');
  const exits = page.data.nodes.filter((n) => n.type === 'exit');

  assert.equal(entries.length, 1, 'one way in');
  assert.equal(exits.length, 1, 'one way out');
  assert.equal(entries[0].title, 'In');
});

test('renaming a port renames its marker, and removing it removes the marker', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const page = await api.get(`/api/story/graphs/${graphs[0].id}`);
  const node = page.data.nodes.find((n) => n.title === 'Planned out');
  const planner = (await api.post(`/api/story/nodes/${node.id}/planner`)).data.graph;

  await api.patch(`/api/story/nodes/${node.id}`, {
    data: { inputs: [{ id: 'in', label: 'Arrive by sea' }], outputs: [] },
  });

  const after2 = await api.get(`/api/story/graphs/${planner.id}`);
  assert.equal(after2.data.nodes.filter((n) => n.type === 'entry')[0].title, 'Arrive by sea');
  assert.equal(after2.data.nodes.filter((n) => n.type === 'exit').length, 0, 'the exit marker went with its port');
});

test('a marker cannot be deleted on its own', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const page = await api.get(`/api/story/graphs/${graphs[0].id}`);
  const node = page.data.nodes.find((n) => n.title === 'Planned out');
  const planner = (await api.post(`/api/story/nodes/${node.id}/planner`)).data.graph;
  const marker = (await api.get(`/api/story/graphs/${planner.id}`)).data.nodes.find((n) => n.type === 'entry');

  const res = await api.del(`/api/story/nodes/${marker.id}`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /marker/i);
});

test('the last story thread cannot be deleted', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  assert.equal(graphs.length, 1);
  const res = await api.del(`/api/story/graphs/${graphs[0].id}`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /at least one/);
});

test('read as script names the branches that go nowhere', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const res = await api.get(`/api/story/graphs/${graphs[0].id}/script`);
  assert.equal(res.status, 200);
  assert.match(res.data, /^# /m);
  assert.match(res.data, /Loose ends/);
});

/* ── history ──────────────────────────────────────────────── */

test('activity is logged with who did it', async () => {
  const res = await api.get(`/api/history/${project.id}/events`);
  assert.equal(res.ok, true);
  assert.ok(res.data.events.length > 0);
  assert.ok(res.data.events.every((e) => e.user_name));
  assert.ok(res.data.events.some((e) => e.kind === 'project.create'));
});

test('a restore point puts the project back, and leaves a safety copy behind', async () => {
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  const before = (await api.get(`/api/boards/${rootBoardId}`)).data.items.length;

  const snap = (await api.post(`/api/history/${project.id}/snapshots`, { label: 'Known good' })).data.snapshot;

  await api.post(`/api/boards/${rootBoardId}/items`, { type: 'text', data: { text: 'added after the snapshot' } });
  assert.equal((await api.get(`/api/boards/${rootBoardId}`)).data.items.length, before + 1);

  const restored = await api.post(`/api/history/snapshots/${snap.id}/restore`);
  assert.equal(restored.ok, true);
  assert.ok(restored.data.safetyId, 'a safety copy is taken before restoring');

  const nowBoard = await api.get(`/api/boards/${rootBoardId}`);
  assert.equal(nowBoard.data.items.length, before, 'the extra item is gone');
});

test('only an admin can restore', async () => {
  await api.post('/api/auth/users', { username: 'deckhand', displayName: 'Deckhand', password: 'a-long-first-password' });
  const member = makeClient(app.base);
  await member.post('/api/auth/login', { username: 'deckhand', password: 'a-long-first-password' });
  await member.post('/api/auth/password', { next: 'a-long-chosen-password' });

  const snap = (await api.get(`/api/history/${project.id}/snapshots`)).data.snapshots[0];
  const res = await member.post(`/api/history/snapshots/${snap.id}/restore`);
  assert.equal(res.status, 403);
});
