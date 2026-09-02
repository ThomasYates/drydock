import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeProject, setupAdmin } from '../test-utils/harness.js';
import { escapeLike, snippet } from '../src/search.js';

let app;
let api;
let project;
let other;

before(async () => {
  app = await boot();
  api = app.api;
  await setupAdmin(api);

  project = await makeProject(api, 'Lighthouse');
  other = await makeProject(api, 'Trawler');

  const { rootBoardId, graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  await api.post(`/api/boards/${rootBoardId}/items`, {
    items: [
      { type: 'text', data: { text: 'The keeper never sleeps. A long note that goes on for a while so the snippet has something to trim around, mentioning the beacon somewhere in the middle of it all, and then carrying on afterwards.' } },
      { type: 'text', data: { text: 'Discount is 50% off' } },
    ],
  });
  await api.post(`/api/boards/${rootBoardId}/items`, { type: 'board', data: { name: 'Beacon references' } });

  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  await api.post(`/api/kanban/columns/${columns[0].id}/cards`, {
    title: 'Model the beacon', body: 'High poly first, then bake it down',
  });

  await api.post(`/api/story/graphs/${graphs[0].id}/nodes`, {
    type: 'beat', title: 'The beacon goes out', body: 'Everything below is dark',
  });
});
after(async () => { await app.stop(); });

test('LIKE wildcards in the query are escaped rather than matching everything', () => {
  assert.equal(escapeLike('50%'), '50!%');
  assert.equal(escapeLike('a_b'), 'a!_b');
  assert.equal(escapeLike('why!'), 'why!!');
  assert.equal(escapeLike('plain'), 'plain');
});

test('a snippet is a window around the match', () => {
  const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
  const out = snippet(long, 'needle');
  assert.ok(out.includes('needle'));
  assert.ok(out.length < 200, `snippet was ${out.length} characters`);
  assert.ok(out.startsWith('…') && out.endsWith('…'));
});

test('a snippet of nothing is nothing', () => {
  assert.equal(snippet('', 'x'), '');
  assert.equal(snippet(null, 'x'), '');
});

test('one query finds notes, cards, beats, boards and projects', async () => {
  const res = await api.get('/api/search?q=beacon');
  assert.equal(res.ok, true);

  const kinds = new Set(res.data.results.map((r) => r.kind));
  for (const kind of ['note', 'card', 'beat', 'board']) {
    assert.ok(kinds.has(kind), `expected a ${kind} hit, got ${[...kinds].join(', ')}`);
  }
});

test('every hit carries a route that leads back to it', async () => {
  const res = await api.get('/api/search?q=beacon');
  for (const hit of res.data.results) {
    assert.match(hit.href, /^\/p\//, `${hit.kind} should link into a project`);
    assert.ok(hit.projectId);
    assert.ok(hit.projectName);
    assert.ok(hit.title);
  }
  const note = res.data.results.find((r) => r.kind === 'note');
  assert.match(note.href, /\/moodboard.*\?focus=/, 'a note links to its board and names the item');
  const beat = res.data.results.find((r) => r.kind === 'beat');
  assert.match(beat.href, /\/story\/.+\?focus=/);
});

test('a project name is matched too', async () => {
  const res = await api.get('/api/search?q=Lighthouse');
  assert.ok(res.data.results.some((r) => r.kind === 'project' && r.title === 'Lighthouse'));
});

test('search can be narrowed to one project', async () => {
  const wide = await api.get('/api/search?q=e');
  assert.equal(wide.data.results.length, 0, 'a single letter is too short to search on');

  const both = await api.get('/api/search?q=beacon');
  assert.ok(both.data.results.length > 0);

  const narrowed = await api.get(`/api/search?q=beacon&projectId=${other.id}`);
  assert.equal(narrowed.data.results.length, 0, 'the other project has no beacons');
});

test('a percent sign is searched for literally', async () => {
  const res = await api.get(`/api/search?q=${encodeURIComponent('50%')}`);
  assert.equal(res.data.results.length, 1, 'only the note that actually says 50%');
  assert.match(res.data.results[0].snippet, /50%/);
});

test('an underscore does not act as a wildcard', async () => {
  const res = await api.get(`/api/search?q=${encodeURIComponent('T_e')}`);
  assert.equal(res.data.results.length, 0, 'T_e should not match "The"');
});

test('a query under two characters returns nothing rather than everything', async () => {
  for (const q of ['', ' ', 'a']) {
    const res = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.data.results.length, 0);
  }
});

test('an absurdly long query is refused', async () => {
  const res = await api.get(`/api/search?q=${'x'.repeat(500)}`);
  assert.equal(res.status, 400);
});

test('story markers are never search results', async () => {
  const { graphs } = (await api.get(`/api/projects/${project.id}`)).data;
  const page = await api.get(`/api/story/graphs/${graphs[0].id}`);
  const node = page.data.nodes[0];
  await api.post(`/api/story/nodes/${node.id}/planner`);

  const res = await api.get('/api/search?q=In');
  assert.ok(!res.data.results.some((r) => r.kind === 'beat' && r.title === 'In'),
    'port markers mirror a port, not content anyone wrote');
});
