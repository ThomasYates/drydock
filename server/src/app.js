/*
 * The Express app, built by a function so the tests can stand one up against a
 * throwaway data directory without the entry point's timers and listener
 * coming along with it. src/index.js is the thing that actually runs.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { UPLOAD_DIR } from './db.js';
import { attachUser, requireAuth } from './auth.js';
import { rateLimit, securityHeaders } from './security.js';
import { VERSION, STARTED_AT } from './version.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import boardRoutes from './routes/boards.js';
import kanbanRoutes from './routes/kanban.js';
import storyRoutes from './routes/story.js';
import imageRoutes from './routes/images.js';
import historyRoutes from './routes/history.js';
import searchRoutes from './routes/search.js';
import updateRoutes from './routes/updates.js';
import transferRoutes from './routes/transfer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp() {
  const app = express();

  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  // generous enough that nobody working normally will ever see it, tight
  // enough that a runaway script or a stranger with the URL cannot grind the
  // box down. The per-account login throttle in auth.js is separate.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600, message: 'Too many requests. Give it a moment.' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, startedAt: STARTED_AT }));
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/boards', boardRoutes);
  app.use('/api/kanban', kanbanRoutes);
  app.use('/api/story', storyRoutes);
  app.use('/api/images', imageRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/updates', updateRoutes);
  app.use('/api/transfer', transferRoutes);

  // uploads are private to signed-in accounts
  app.use('/media', requireAuth, express.static(UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'),
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

  if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '7d' }));
    app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  } else {
    app.get('*', (_req, res) =>
      res.status(503).send('Frontend not built. Run the Docker build, or `npm run build` in /web.'));
  }

  // Express identifies an error handler by its four arguments, so _next has
  // to stay in the signature even though nothing calls it.
  app.use((err, _req, res, _next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON' });
    console.error(err);
    return res.status(500).json({ error: 'Something broke on the server' });
  });

  return app;
}
