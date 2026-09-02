import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeClient, makeProject, ONE_PIXEL_PNG, setupAdmin } from '../test-utils/harness.js';

let app;
let api;
let project;

before(async () => {
  app = await boot();
  api = app.api;
  await setupAdmin(api);
  project = await makeProject(api, 'Pictures');
});
after(async () => { await app.stop(); });

const uploadOne = async (name = 'dock.png') => {
  const form = new FormData();
  form.append('files', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), name);
  return api.post(`/api/images/project/${project.id}`, form);
};

test('an upload is re-encoded to WebP and stored with a proxy alongside', async () => {
  const res = await uploadOne();
  assert.equal(res.ok, true);

  const image = res.data.images[0];
  assert.match(image.file, /\.webp$/);
  assert.match(image.thumb, /_t\.webp$/);
  assert.equal(image.original_name, 'dock.png');
  assert.ok(image.width > 0 && image.height > 0);
  assert.ok(image.bytes > 0);
});

test('uploaded files are only served to a signed-in account', async () => {
  const image = (await api.get(`/api/images/project/${project.id}`)).data.images[0];

  const mine = await api.raw('GET', `/media/${image.file}`);
  assert.equal(mine.status, 200);

  const stranger = makeClient(app.base);
  const theirs = await stranger.raw('GET', `/media/${image.file}`);
  assert.equal(theirs.status, 401, 'uploads are not public');
});

test('a file that is not an image is refused', async () => {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('this is not a picture')], { type: 'image/png' }), 'lies.png');
  const res = await api.post(`/api/images/project/${project.id}`, form);
  assert.equal(res.status, 415);
});

test('an image still on a board will not be deleted by accident', async () => {
  const image = (await uploadOne('used.png')).data.images[0];
  const { rootBoardId } = (await api.get(`/api/projects/${project.id}`)).data;
  await api.post(`/api/boards/${rootBoardId}/items`, { type: 'image', data: { imageId: image.id } });

  const refused = await api.del(`/api/images/${image.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.used, 1);

  const forced = await api.del(`/api/images/${image.id}`, { force: true });
  assert.equal(forced.ok, true);

  const board = await api.get(`/api/boards/${rootBoardId}`);
  assert.equal(board.data.items.filter((i) => i.type === 'image').length, 0, 'the tile went with it');
});

/*
 * Adding an image by address is the only request the server makes on behalf of
 * a signed-in person, so it is the only route where server-side request
 * forgery is possible at all. These are the cases that matter.
 */
test('a loopback address cannot be fetched', async () => {
  const res = await api.post(`/api/images/project/${project.id}/from-url`, {
    url: `${app.base}/api/health`,
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /private or internal/);
});

test('the cloud metadata address cannot be fetched', async () => {
  const res = await api.post(`/api/images/project/${project.id}/from-url`, {
    url: 'http://169.254.169.254/latest/meta-data/',
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /private or internal/);
});

test('addresses on the local network cannot be fetched', async () => {
  for (const url of ['http://192.168.1.1/x.png', 'http://10.0.0.5:8080/x.png', 'http://[::1]/x.png']) {
    const res = await api.post(`/api/images/project/${project.id}/from-url`, { url });
    assert.equal(res.status, 400, `${url} should be refused`);
    assert.match(res.data.error, /private or internal/);
  }
});

test('only http and https addresses are accepted', async () => {
  for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://example.com/a.png']) {
    const res = await api.post(`/api/images/project/${project.id}/from-url`, { url });
    assert.equal(res.status, 400, `${url} should be refused`);
  }
});

test('an empty address says what is wanted', async () => {
  const res = await api.post(`/api/images/project/${project.id}/from-url`, { url: '  ' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /http or https/);
});

test('adding an image to a project that is not there is a 404', async () => {
  const res = await api.post('/api/images/project/p_nope/from-url', { url: 'https://example.com/a.png' });
  assert.equal(res.status, 404);
});
