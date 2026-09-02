import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { logEvent } from '../history.js';
import {
  buildExport, importProject, readArchive, validateManifest, writeMedia,
} from '../transfer.js';

const r = Router();
r.use(requireAuth);

const MAX_IMPORT_MB = Number(process.env.MAX_IMPORT_MB || 512);

/*
 * An archive goes to a temp file rather than memory: a project with three
 * hundred references is a few hundred megabytes, and holding that in a Buffer
 * while a second person does the same is how a small container gets killed.
 */
const upload = multer({
  dest: path.join(os.tmpdir(), 'drydock-import'),
  limits: { fileSize: MAX_IMPORT_MB * 1024 * 1024, files: 1 },
});

r.get('/:projectId/export', (req, res) => {
  const archive = buildExport(req.params.projectId);
  if (!archive) return res.status(404).json({ error: 'No such project' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
  // the archive is built as it streams, so its length is not known up front
  res.setHeader('Cache-Control', 'no-store');

  archive.stream.on('error', (e) => {
    console.error('export failed', e);
    res.destroy();
  });
  archive.stream.pipe(res);

  logEvent(req.params.projectId, req.user, 'project.export', 'Exported the project', archive.counts);
  return undefined;
});

r.post('/import', upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a .drydock.zip file to import' });

  try {
    const { manifest, media } = await readArchive(req.file.path);

    const problem = validateManifest(manifest);
    if (problem) return res.status(400).json({ error: problem });

    const requested = String(req.body?.name || '').trim();
    const name = (requested || manifest.data.project.name || 'Imported project').slice(0, 200);

    const { projectId, files, counts } = importProject(manifest, { user: req.user, name });
    const written = writeMedia(files, media);

    logEvent(projectId, req.user, 'project.import',
      `Imported “${name}” from an archive`, { ...counts, mediaFiles: written });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const rootBoardId = db.prepare('SELECT id FROM boards WHERE project_id = ? AND is_root = 1').get(projectId)?.id;
    return res.json({ project: { ...project, root_board_id: rootBoardId }, counts, mediaFiles: written });
  } catch (e) {
    // readArchive and validateManifest raise sentences meant to be read
    return res.status(400).json({ error: e.message || 'That archive could not be imported.' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

export default r;
