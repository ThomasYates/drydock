import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeProject, ONE_PIXEL_PNG, setupAdmin } from '../test-utils/harness.js';
import { exportFilename, safeMediaName, validateManifest } from '../src/transfer.js';

let app;
let api;
let project;

before(async () => {
  app = await boot();
  api = app.api;
  await setupAdmin(api);
  project = await makeProject(api, 'The Whole Thing');

  const { rootBoardId, graphs } = (await api.get(`/api/projects/${project.id}`)).data;

  // an image, referenced from the board, so the archive has to carry the file
  const form = new FormData();
  form.append('files', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'dock.png');
  const uploaded = await api.post(`/api/images/project/${project.id}`, form);
  const image = uploaded.data.images[0];

  await api.post(`/api/boards/${rootBoardId}/items`, {
    items: [
      { type: 'image', x: 0, y: 0, data: { imageId: image.id } },
      { type: 'text', x: 200, y: 0, data: { text: 'travels with the project' } },
    ],
  });
  const tile = (await api.post(`/api/boards/${rootBoardId}/items`, {
    type: 'board', data: { name: 'Nested' },
  })).data.items[0];
  await api.post(`/api/boards/${tile.data.boardId}/items`, { type: 'text', data: { text: 'deep inside' } });

  const { columns } = (await api.get(`/api/kanban/${project.id}`)).data;
  await api.post(`/api/kanban/columns/${columns[0].id}/cards`, {
    title: 'Travelling card', checklist: [{ id: 'c1', text: 'packed', done: true }],
  });

  const nodes = (await api.get(`/api/story/graphs/${graphs[0].id}`)).data.nodes;
  await api.post(`/api/story/graphs/${graphs[0].id}/edges`, {
    fromNode: nodes[2].id, toNode: nodes[0].id,
  });
});
after(async () => { await app.stop(); });

test('the download gets a name someone will recognise later', () => {
  assert.match(exportFilename('The Whole Thing'), /^the-whole-thing-\d{4}-\d{2}-\d{2}\.drydock\.zip$/);
  assert.match(exportFilename('  !!!  '), /^project-/);
  assert.match(exportFilename(''), /^project-/);
});

test('an archive entry cannot escape the media folder', () => {
  assert.equal(safeMediaName('media/img_abc.webp'), 'img_abc.webp');
  assert.equal(safeMediaName('media/../../etc/passwd'), null);
  assert.equal(safeMediaName('media/nested/thing.webp'), null);
  assert.equal(safeMediaName('media/..'), null);
  assert.equal(safeMediaName('media/.hidden.webp'), null);
  assert.equal(safeMediaName('media/thing.sh'), null);
  assert.equal(safeMediaName('elsewhere/img.webp'), null);
  assert.equal(safeMediaName('drydock-project.json'), null);
});

test('a manifest is checked before anything is written', () => {
  assert.match(validateManifest(null), /does not contain a project/);
  assert.match(validateManifest({ format: 'something-else' }), /not exported from Drydock/);
  assert.match(validateManifest({ format: 'drydock-project', formatVersion: 99 }), /newer Drydock/);
  assert.match(validateManifest({ format: 'drydock-project', formatVersion: 1, data: {} }), /does not contain a project/);
  assert.equal(validateManifest({
    format: 'drydock-project', formatVersion: 1, data: { project: { name: 'x' } },
  }), null);
});

test('export streams a zip with a sensible filename', async () => {
  const res = await api.raw('GET', `/api/transfer/${project.id}/export`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="the-whole-thing-.*\.drydock\.zip"/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'that is a zip file');
  assert.ok(buf.length > 500);
});

test('exporting a project that is not there is a 404', async () => {
  const res = await api.get('/api/transfer/p_nope/export');
  assert.equal(res.status, 404);
});

test('an exported project imports back as a separate copy, intact', async () => {
  const res = await api.raw('GET', `/api/transfer/${project.id}/export`);
  const archive = Buffer.from(await res.arrayBuffer());

  const form = new FormData();
  form.append('archive', new Blob([archive], { type: 'application/zip' }), 'export.drydock.zip');
  form.append('name', 'Imported copy');
  const imported = await api.post('/api/transfer/import', form);

  assert.equal(imported.ok, true, JSON.stringify(imported.data));
  const copy = imported.data.project;
  assert.equal(copy.name, 'Imported copy');
  assert.notEqual(copy.id, project.id, 'a new project, not the old one');
  assert.ok(imported.data.mediaFiles >= 2, 'the image and its proxy came along');

  // the original is untouched
  assert.equal((await api.get(`/api/projects/${project.id}`)).ok, true);

  const board = await api.get(`/api/boards/${copy.root_board_id}`);
  assert.equal(board.data.items.length, 3, 'image, note and nested board tile');

  const imageItem = board.data.items.find((i) => i.type === 'image');
  assert.ok(imageItem.data.imageId.startsWith('img_'));
  assert.ok(board.data.images.some((img) => img.id === imageItem.data.imageId),
    'the image id was remapped to the copy, not left pointing at the original');

  const nestedTile = board.data.items.find((i) => i.type === 'board');
  const nested = await api.get(`/api/boards/${nestedTile.data.boardId}`);
  assert.equal(nested.data.items[0].data.text, 'deep inside');
  assert.equal(nested.data.board.project_id, copy.id, 'the nested board belongs to the copy');

  const kanban = await api.get(`/api/kanban/${copy.id}`);
  assert.equal(kanban.data.columns.length, 5);
  const travelled = kanban.data.cards.find((c) => c.title === 'Travelling card');
  assert.equal(travelled.checklist[0].text, 'packed');

  const { graphs } = (await api.get(`/api/projects/${copy.id}`)).data;
  const page = await api.get(`/api/story/graphs/${graphs[0].id}`);
  assert.equal(page.data.nodes.length, 3);
  assert.equal(page.data.edges.length, 3, 'the links came across, pointing at the copies');
  for (const edge of page.data.edges) {
    assert.ok(page.data.nodes.some((n) => n.id === edge.from_node), 'every link starts on a node in this copy');
    assert.ok(page.data.nodes.some((n) => n.id === edge.to_node), 'every link ends on a node in this copy');
  }
});

test('the image files in a copy are real files, not references to the original', async () => {
  const projects = (await api.get('/api/projects')).data.projects;
  const copy = projects.find((p) => p.name === 'Imported copy');
  const images = (await api.get(`/api/images/project/${copy.id}`)).data.images;
  assert.equal(images.length, 1);

  const res = await api.raw('GET', `/media/${images[0].file}`);
  assert.equal(res.status, 200, 'the copied file is served');
  assert.ok(Number(res.headers.get('content-length')) > 0);
});

test('importing without a file says so', async () => {
  const res = await api.post('/api/transfer/import', new FormData());
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Choose a/);
});

test('a file that is not a zip is refused', async () => {
  const form = new FormData();
  form.append('archive', new Blob([Buffer.from('this is just some text')]), 'notazip.zip');
  const res = await api.post('/api/transfer/import', form);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /zip|archive/i);
});

test('a zip without a Drydock manifest is refused', async () => {
  const yazl = (await import('yazl')).default;
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('nothing to see'), 'readme.txt');
  zip.end();

  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);

  const form = new FormData();
  form.append('archive', new Blob([Buffer.concat(chunks)]), 'empty.zip');
  const res = await api.post('/api/transfer/import', form);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /drydock-project\.json/);
});

test('importing needs an account', async () => {
  const { makeClient } = await import('../test-utils/harness.js');
  const stranger = makeClient(app.base);
  const res = await stranger.post('/api/transfer/import', new FormData());
  assert.equal(res.status, 401);
});
