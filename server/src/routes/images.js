import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { db, uid, now, UPLOAD_DIR } from '../db.js';
import { requireAuth } from '../auth.js';
import { fetchChecked } from '../net.js';
import { logEvent, fileIsProtected } from '../history.js';

const r = Router();
r.use(requireAuth);

const MAX_EDGE = Number(process.env.IMAGE_MAX_EDGE || 2200);
const QUALITY = Number(process.env.IMAGE_QUALITY || 78);
const THUMB_EDGE = 480;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 40);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 40 },
});

sharp.cache({ files: 0 });

async function store(projectId, buffer, originalName, userId, sourceUrl = null) {
  const base = uid('img_');
  const file = `${base}.webp`;
  const thumb = `${base}_t.webp`;

  const pipeline = sharp(buffer, { failOn: 'none', animated: false }).rotate();
  const meta = await pipeline.metadata();

  const info = await pipeline
    .clone()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY, effort: 4 })
    .toFile(path.join(UPLOAD_DIR, file));

  await sharp(buffer, { failOn: 'none', animated: false })
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 60, effort: 4 })
    .toFile(path.join(UPLOAD_DIR, thumb));

  const row = {
    id: base, project_id: projectId,
    original_name: originalName || 'pasted.png',
    file, thumb,
    width: info.width || meta.width || 0,
    height: info.height || meta.height || 0,
    bytes: info.size || buffer.length,
    source_url: sourceUrl,
    uploaded_by: userId,
    created_at: now(),
  };
  db.prepare(`INSERT INTO images (id, project_id, original_name, file, thumb, width, height, bytes, source_url, uploaded_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.project_id, row.original_name, row.file, row.thumb, row.width, row.height, row.bytes, row.source_url, row.uploaded_by, row.created_at);
  return row;
}

r.get('/project/:projectId', (req, res) => {
  res.json({ images: db.prepare('SELECT * FROM images WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId) });
});

r.post('/project/:projectId', upload.array('files', 40), async (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'No such project' });
  const out = [];
  for (const f of req.files || []) {
    try {
      out.push(await store(project.id, f.buffer, f.originalname, req.user.id));
    } catch {
      return res.status(415).json({ error: `Could not read ${f.originalname}. Try PNG, JPG, WebP, GIF, AVIF or TIFF.` });
    }
  }
  if (out.length) {
    logEvent(project.id, req.user, 'image.upload',
      `Uploaded ${out.length} image${out.length > 1 ? 's' : ''}`, { ids: out.map((i) => i.id) });
  }
  res.json({ images: out });
});

/*
 * Pulling an image in by address is the one request Drydock makes on behalf of
 * whoever is signed in, which makes it the one place server-side request
 * forgery could get in. fetchChecked resolves the name, refuses anything on a
 * private or internal network, and checks every redirect hop the same way.
 */
r.post('/project/:projectId/from-url', async (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'No such project' });

  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a full http or https image address' });

  const got = await fetchChecked(url, { maxBytes: MAX_UPLOAD_MB * 1024 * 1024 });
  if (!got.ok) return res.status(400).json({ error: got.error });

  const name = safeName(got.url);
  try {
    const image = await store(project.id, got.buffer, name, req.user.id, got.url.toString());
    logEvent(project.id, req.user, 'image.upload', `Pulled in “${name}” from the web`, { ids: [image.id] });
    return res.json({ image });
  } catch {
    return res.status(415).json({ error: 'That address did not return a picture Drydock can read' });
  }
});

/** The last path segment, made safe to show and to store. */
function safeName(url) {
  try {
    const raw = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    // strip control characters rather than let one into a filename or a log line
    const cleaned = [...raw]
      .filter((ch) => { const c = ch.codePointAt(0); return c > 31 && c !== 127; })
      .join('')
      .trim()
      .slice(0, 120);
    return cleaned || 'linked-image';
  } catch {
    return 'linked-image';
  }
}

r.delete('/:id', (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'No such image' });
  const used = db.prepare("SELECT COUNT(*) c FROM items WHERE type='image' AND json_extract(data,'$.imageId') = ?").get(img.id).c;
  if (used && !req.body?.force) {
    return res.status(409).json({ error: `That image is on ${used} board${used > 1 ? 's' : ''}`, used });
  }
  db.prepare("DELETE FROM items WHERE type='image' AND json_extract(data,'$.imageId') = ?").run(img.id);
  db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
  db.prepare('UPDATE projects SET cover_image_id = NULL WHERE cover_image_id = ?').run(img.id);
  // hold on to the file while a restore point could still need it
  if (!fileIsProtected(img.project_id)) {
    for (const f of [img.file, img.thumb]) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
    }
  }
  logEvent(img.project_id, req.user, 'image.delete', `Deleted the image “${img.original_name}”`, {});
  res.json({ ok: true });
});

export default r;
