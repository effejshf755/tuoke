import { Router } from 'express';
import type { Request } from 'express';
import { getDb } from '../db/index.js';

export const adminUsersRouter = Router();

adminUsersRouter.get('/', (_req, res) => {
  const rows = getDb().prepare(`
    SELECT u.id, u.email, u.role, u.status, u.created_at, u.monthly_token_limit,
           COALESCE(SUM(CASE WHEN r.created_at >= strftime('%Y-%m-01 00:00:00', 'now') THEN r.input_tokens + r.output_tokens ELSE 0 END), 0) AS monthly_used_tokens
      FROM users u LEFT JOIN requests r ON r.consumer_user_id = u.id
     GROUP BY u.id ORDER BY u.id
  `).all();
  res.json({ users: rows });
});

adminUsersRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const actor = (req as unknown as Request & { user: { userId: number } }).user;
  if (req.body.status === 'disabled' && actor.userId === id) { res.status(400).json({ error: { message: 'You cannot disable yourself' } }); return; }
  const db = getDb();
  const current = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as { id: number; role: string } | undefined;
  if (!current) { res.status(404).json({ error: { message: 'User not found' } }); return; }
  if (req.body.status && !['active', 'disabled'].includes(req.body.status)) { res.status(400).json({ error: { message: 'Invalid status' } }); return; }
  if (req.body.status === 'disabled' && current.role === 'admin') { res.status(400).json({ error: { message: 'Administrators cannot be disabled' } }); return; }
  if (req.body.monthly_token_limit !== undefined) {
    const limit = Number(req.body.monthly_token_limit);
    if (!Number.isInteger(limit) || limit < 0) { res.status(400).json({ error: { message: 'Invalid monthly token limit' } }); return; }
    db.prepare('UPDATE users SET monthly_token_limit = ? WHERE id = ?').run(limit, id);
  }
  if (req.body.status) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(req.body.status, id);
  res.json({ success: true });
});
