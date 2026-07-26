import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';

export const notificationsRouter = Router();
export const adminNotificationsRouter = Router();

const publishSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000),
  kind: z.enum(['info', 'important', 'maintenance']).default('info'),
});

function userId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

notificationsRouter.get('/', (req, res) => {
  const id = userId(req);
  const rows = getDb().prepare(`
    SELECT n.id, n.title, n.content, n.kind, n.published_at publishedAt,
      r.read_at readAt
    FROM site_notifications n
    LEFT JOIN site_notification_reads r
      ON r.notification_id = n.id AND r.user_id = ?
    ORDER BY n.published_at DESC, n.id DESC
    LIMIT 100
  `).all(id) as Array<Record<string, unknown>>;
  const unread = getDb().prepare(`
    SELECT COUNT(*) count FROM site_notifications n
    WHERE NOT EXISTS (
      SELECT 1 FROM site_notification_reads r
      WHERE r.notification_id = n.id AND r.user_id = ?
    )
  `).get(id) as { count: number };
  res.json({ notifications: rows, unreadCount: unread.count });
});

notificationsRouter.post('/:id/read', (req, res) => {
  const notificationId = Number(req.params.id);
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    res.status(400).json({ error: { message: 'Invalid notification id', type: 'invalid_request' } });
    return;
  }
  const exists = getDb().prepare('SELECT 1 FROM site_notifications WHERE id = ?').get(notificationId);
  if (!exists) {
    res.status(404).json({ error: { message: 'Notification not found', type: 'not_found' } });
    return;
  }
  getDb().prepare(`
    INSERT INTO site_notification_reads (notification_id, user_id)
    VALUES (?, ?)
    ON CONFLICT(notification_id, user_id) DO NOTHING
  `).run(notificationId, userId(req));
  res.json({ success: true });
});

notificationsRouter.post('/read-all', (req, res) => {
  getDb().prepare(`
    INSERT OR IGNORE INTO site_notification_reads (notification_id, user_id)
    SELECT id, ? FROM site_notifications
  `).run(userId(req));
  res.json({ success: true });
});

adminNotificationsRouter.get('/', (_req, res) => {
  const rows = getDb().prepare(`
    SELECT n.id, n.title, n.content, n.kind, n.published_at publishedAt,
      u.email publishedBy,
      (SELECT COUNT(*) FROM site_notification_reads r WHERE r.notification_id = n.id) readCount,
      (SELECT COUNT(*) FROM users WHERE status = 'active') recipientCount
    FROM site_notifications n
    LEFT JOIN users u ON u.id = n.published_by
    ORDER BY n.published_at DESC, n.id DESC
    LIMIT 200
  `).all();
  res.json({ notifications: rows });
});

adminNotificationsRouter.post('/', (req, res) => {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid notification', type: 'validation_error', details: parsed.error.flatten() } });
    return;
  }
  const result = getDb().prepare(`
    INSERT INTO site_notifications (title, content, kind, published_by)
    VALUES (?, ?, ?, ?)
  `).run(parsed.data.title, parsed.data.content, parsed.data.kind, userId(req));
  const notification = getDb().prepare(`
    SELECT id, title, content, kind, published_at publishedAt
    FROM site_notifications WHERE id = ?
  `).get(Number(result.lastInsertRowid));
  res.status(201).json({ notification });
});

adminNotificationsRouter.delete('/:id', (req, res) => {
  const notificationId = Number(req.params.id);
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    res.status(400).json({ error: { message: 'Invalid notification id', type: 'invalid_request' } });
    return;
  }
  const result = getDb().prepare('DELETE FROM site_notifications WHERE id = ?').run(notificationId);
  if (result.changes !== 1) {
    res.status(404).json({ error: { message: 'Notification not found', type: 'not_found' } });
    return;
  }
  res.json({ success: true });
});
