import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';

async function call(app: Express, method: string, path: string, body?: unknown, token?: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('site notifications', () => {
  let app: Express;
  let adminToken: string;
  let userToken: string;
  let notificationId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const admin = createUser('notifications-admin@example.com', 'supersecret');
    const user = createUser('notifications-user@example.com', 'supersecret');
    getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    getDb().prepare("UPDATE users SET role = 'user' WHERE id = ?").run(user.userId);
    adminToken = createSession(admin.userId);
    userToken = createSession(user.userId);
  });

  it('protects admin publishing', async () => {
    expect((await call(app, 'POST', '/api/admin/notifications', { title: 'x', content: 'y' })).status).toBe(401);
    expect((await call(app, 'POST', '/api/admin/notifications', { title: 'x', content: 'y' }, userToken)).status).toBe(403);
  });

  it('publishes a broadcast notification', async () => {
    const response = await call(app, 'POST', '/api/admin/notifications', {
      title: '服务更新', content: '今晚完成模型升级。', kind: 'important',
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.notification).toMatchObject({ title: '服务更新', kind: 'important' });
    notificationId = response.body.notification.id;
  });

  it('lists unread notifications for a user and marks one read', async () => {
    const before = await call(app, 'GET', '/api/user/notifications', undefined, userToken);
    expect(before.status).toBe(200);
    expect(before.body.unreadCount).toBe(1);
    expect(before.body.notifications[0]).toMatchObject({ id: notificationId, readAt: null });

    expect((await call(app, 'POST', `/api/user/notifications/${notificationId}/read`, {}, userToken)).status).toBe(200);
    const after = await call(app, 'GET', '/api/user/notifications', undefined, userToken);
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.notifications[0].readAt).toBeTruthy();
  });

  it('reports readership and deletes a notification', async () => {
    const list = await call(app, 'GET', '/api/admin/notifications', undefined, adminToken);
    expect(list.status).toBe(200);
    expect(list.body.notifications[0]).toMatchObject({ id: notificationId, readCount: 1 });
    expect((await call(app, 'DELETE', `/api/admin/notifications/${notificationId}`, undefined, adminToken)).status).toBe(200);
    const userList = await call(app, 'GET', '/api/user/notifications', undefined, userToken);
    expect(userList.body.notifications).toEqual([]);
  });
});
