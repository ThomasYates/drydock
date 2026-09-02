/*
 * Moving a whole project out of one Drydock and into another.
 *
 * A restore point covers "put this project back the way it was on Tuesday".
 * It does not cover "put this project on a different machine", because the
 * snapshot lives inside the database it belongs to and refers to image files
 * by name in that install's own uploads directory. An export is the portable
 * version: one zip holding the same JSON plus every picture it mentions.
 *
 * Import never merges into an existing project. It builds a new one with fresh
 * ids throughout, so importing the same file twice gives two projects rather
 * than a half-overwritten one.
 */
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { db, uid, now, UPLOAD_DIR } from './db.js';
import { dump } from './history.js';
import { VERSION } from './version.js';

export const MANIFEST = 'drydock-project.json';
export const FORMAT = 'drydock-project';
export const FORMAT_VERSION = 1;
const MEDIA_PREFIX = 'media/';
const MAX_ENTRIES = 20_000;

/* ── export ──────────────────────────────────────────────── */

/** A filename someone will recognise six months later in a downloads folder. */
export function exportFilename(projectName) {
  const slug = String(projectName || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
  return `${slug}-${new Date().toISOString().slice(0, 10)}.drydock.zip`;
}

/**
 * Build the archive as a readable stream. Images are stored rather than
 * deflated — they are already WebP, so compressing them again costs CPU and
 * saves nothing.
 */
export function buildExport(projectId) {
  const data = dump(projectId);
  if (!data) return null;

  const zip = new yazl.ZipFile();
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: now(),
    exportedBy: VERSION,
    data,
  };
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), MANIFEST);

  for (const image of data.images) {
    for (const name of [image.file, image.thumb]) {
      const full = path.join(UPLOAD_DIR, name);
      // a missing file is not worth failing the whole export over
      if (name && fs.existsSync(full)) zip.addFile(full, MEDIA_PREFIX + name, { compress: false });
    }
  }

  zip.end();
  return { stream: zip.outputStream, filename: exportFilename(data.project.name), counts: countsOf(data) };
}

const countsOf = (d) => ({
  boards: d.boards.length,
  items: d.items.length,
  images: d.images.length,
  cards: d.cards.length,
  nodes: d.nodes.length,
  edges: d.edges.length,
});

/* ── import ──────────────────────────────────────────────── */

/**
 * Reject anything that is not a plain filename sitting directly under media/.
 * This is the guard against zip slip: an archive entry called
 * `media/../../etc/cron.d/x` must never become a path we write to.
 */
export function safeMediaName(entryName) {
  if (typeof entryName !== 'string' || !entryName.startsWith(MEDIA_PREFIX)) return null;
  const name = entryName.slice(MEDIA_PREFIX.length);
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
  if (!/^[A-Za-z0-9_-]+\.webp$/.test(name)) return null;
  return name;
}

/** Read a .drydock.zip into { manifest, media: Map<name, Buffer> }. */
export function readArchive(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) {
        reject(new Error('That file is not a readable zip archive.'));
        return;
      }

      let manifest = null;
      let settled = false;
      const media = new Map();
      let seen = 0;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(new Error(message));
      };

      zip.on('error', () => fail('That archive could not be read.'));

      zip.on('end', () => {
        if (settled) return;
        if (!manifest) {
          fail(`That archive has no ${MANIFEST} in it.`);
          return;
        }
        settled = true;
        resolve({ manifest, media });
      });

      zip.on('entry', (entry) => {
        seen += 1;
        if (seen > MAX_ENTRIES) {
          fail('That archive has far too many files in it.');
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }

        const mediaName = safeMediaName(entry.fileName);
        if (entry.fileName !== MANIFEST && !mediaName) {
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            fail('That archive could not be read.');
            return;
          }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', () => fail('That archive could not be read.'));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (entry.fileName === MANIFEST) {
              try {
                manifest = JSON.parse(buf.toString('utf8'));
              } catch {
                fail(`The ${MANIFEST} inside that archive is not valid JSON.`);
                return;
              }
            } else {
              media.set(mediaName, buf);
            }
            zip.readEntry();
          });
        });
      });

      zip.readEntry();
    });
  });
}

const list = (value) => (Array.isArray(value) ? value : []);

/** Say plainly what is wrong rather than failing halfway through an import. */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'That archive does not contain a project.';
  if (manifest.format !== FORMAT) return 'That archive was not exported from Drydock.';
  if (Number(manifest.formatVersion) > FORMAT_VERSION) {
    return `That archive was written by a newer Drydock (format ${manifest.formatVersion}). Update this one first.`;
  }
  const d = manifest.data;
  if (!d || typeof d !== 'object' || !d.project || typeof d.project.name !== 'string') {
    return 'That archive does not contain a project.';
  }
  return null;
}

/**
 * Rebuild everything under new ids. One transaction, so a bad archive leaves
 * nothing behind — either the whole project appears or none of it does.
 */
export function importProject(manifest, { user, name }) {
  const d = manifest.data;
  const t = now();

  const boards = list(d.boards);
  const items = list(d.items);
  const images = list(d.images);
  const columns = list(d.columns);
  const cards = list(d.cards);
  const graphs = list(d.graphs);
  const nodes = list(d.nodes);
  const edges = list(d.edges);

  // every id is allocated up front, because graphs point at nodes and nodes
  // point back at graphs — there is no insert order that avoids a forward
  // reference, so the mapping has to exist before the first row is written
  const projectId = uid('p_');
  const map = new Map();
  const allocate = (prefix, rows) => rows.forEach((row) => map.set(row.id, uid(prefix)));
  allocate('b_', boards);
  allocate('i_', items);
  allocate('img_', images);
  allocate('c_', columns);
  allocate('k_', cards);
  allocate('g_', graphs);
  allocate('n_', nodes);

  const to = (id) => (id ? map.get(id) || null : null);

  // new ids mean new filenames, so two imports of the same archive cannot
  // fight over one file on disk
  const files = [];
  const renamedImages = images.map((img) => {
    const base = map.get(img.id);
    const file = `${base}.webp`;
    const thumb = `${base}_t.webp`;
    files.push({ from: img.file, to: file }, { from: img.thumb, to: thumb });
    return { ...img, id: base, file, thumb };
  });

  const write = db.transaction(() => {
    db.prepare(`INSERT INTO projects (id, name, summary, status, cover_image_id, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(projectId, name, String(d.project.summary || ''), 'active',
        to(d.project.cover_image_id), user?.id ?? null, t, t);

    // parents before children, so a nested board's parent already exists
    const ordered = [...boards].sort((a, b) => (a.parent_board_id ? 1 : 0) - (b.parent_board_id ? 1 : 0));
    for (const b of ordered) {
      db.prepare('INSERT INTO boards (id, project_id, parent_board_id, name, is_root, created_at) VALUES (?,?,?,?,?,?)')
        .run(map.get(b.id), projectId, to(b.parent_board_id), String(b.name || 'Board'),
          b.is_root ? 1 : 0, b.created_at || t);
    }

    for (const img of renamedImages) {
      db.prepare(`INSERT INTO images (id, project_id, original_name, file, thumb, width, height, bytes, source_url, uploaded_by, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(img.id, projectId, String(img.original_name || 'image'), img.file, img.thumb,
          Number(img.width) || 0, Number(img.height) || 0, Number(img.bytes) || 0,
          img.source_url || null, user?.id ?? null, img.created_at || t);
    }

    for (const it of items) {
      let data = {};
      try { data = JSON.parse(it.data || '{}'); } catch { data = {}; }
      // the two places a board item points at something else by id
      if (data.boardId) data.boardId = to(data.boardId);
      if (data.imageId) data.imageId = to(data.imageId);
      db.prepare('INSERT INTO items (id, board_id, type, x, y, w, h, z, rot, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(map.get(it.id), to(it.board_id), it.type, it.x, it.y, it.w, it.h, it.z, it.rot,
          JSON.stringify(data), it.updated_at || t);
    }

    for (const col of columns) {
      db.prepare('INSERT INTO columns (id, project_id, name, position, wip_limit) VALUES (?,?,?,?,?)')
        .run(map.get(col.id), projectId, String(col.name || 'Column'), col.position, col.wip_limit ?? null);
    }

    for (const c of cards) {
      db.prepare(`INSERT INTO cards (id, column_id, title, body, position, tags, due, assignee, checklist, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(map.get(c.id), to(c.column_id), String(c.title || 'Card'), String(c.body || ''),
          c.position, c.tags || '[]', c.due || null,
          // an assignee is an account id in the install it came from, which
          // means nothing in this one
          null, c.checklist || '[]', c.created_at || t, c.updated_at || t);
    }

    for (const g of graphs) {
      db.prepare('INSERT INTO graphs (id, project_id, parent_node_id, name, position, created_at) VALUES (?,?,?,?,?,?)')
        .run(map.get(g.id), projectId, to(g.parent_node_id), String(g.name || 'Thread'),
          g.position || 0, g.created_at || t);
    }

    for (const n of nodes) {
      db.prepare('INSERT INTO nodes (id, graph_id, type, title, body, x, y, w, h, data, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(map.get(n.id), to(n.graph_id), n.type, String(n.title || 'Untitled'), String(n.body || ''),
          n.x, n.y, n.w, n.h, n.data || '{}', n.updated_at || t);
    }

    for (const e of edges) {
      const from = to(e.from_node);
      const target = to(e.to_node);
      // an edge whose ends did not come along is dropped rather than dangling
      if (!from || !target) continue;
      db.prepare('INSERT INTO edges (id, graph_id, from_node, from_port, to_node, to_port, label) VALUES (?,?,?,?,?,?,?)')
        .run(uid('e_'), to(e.graph_id), from, e.from_port || 'out', target, e.to_port || 'in', e.label || '');
    }
  });

  write();

  return {
    projectId,
    files,
    counts: {
      boards: boards.length,
      items: items.length,
      images: images.length,
      cards: cards.length,
      nodes: nodes.length,
      edges: edges.length,
    },
  };
}

/** Put the pictures on disk. Called once the transaction has committed. */
export function writeMedia(files, media) {
  let written = 0;
  for (const { from, to: name } of files) {
    const buf = media.get(from);
    if (!buf) continue;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      written += 1;
    } catch (e) {
      console.error(`could not write ${name}`, e);
    }
  }
  return written;
}
