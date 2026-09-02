import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { searchAll } from '../search.js';

const r = Router();
r.use(requireAuth);

r.get('/', (req, res) => {
  const q = String(req.query.q || '');
  if (q.length > 200) return res.status(400).json({ error: 'That search is too long' });
  return res.json(searchAll(q, {
    projectId: req.query.projectId ? String(req.query.projectId) : null,
    limit: req.query.limit,
  }));
});

export default r;
