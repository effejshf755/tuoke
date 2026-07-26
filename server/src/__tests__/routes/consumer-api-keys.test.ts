import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';

async function call(app: Express, path: string, token: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('consumer API key secret endpoint', () => {
  let app: Express;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const owner = createUser('key-owner@example.com', 'supersecret');
    const other = createUser('key-other@example.com', 'supersecret');
    ownerId = owner.userId;
    ownerToken = createSession(owner.userId);
    otherToken = createSession(other.userId);
  });

  it('reveals a newly created key only to its owner without leaking it in the list', async () => {
    const created = createConsumerApiKey(getDb(), ownerId, 'Reusable key');
    const ownerResponse = await call(app, `/api/consumer-keys/${created.record.id}/secret`, ownerToken);
    expect(ownerResponse).toEqual({ status: 200, body: { key: created.key } });
    expect((await call(app, `/api/consumer-keys/${created.record.id}/secret`, otherToken)).status).toBe(404);

    const listResponse = await call(app, '/api/consumer-keys', ownerToken);
    expect(listResponse.status).toBe(200);
    expect(JSON.stringify(listResponse.body)).not.toContain(created.key);
    expect(JSON.stringify(listResponse.body)).not.toContain('key_encrypted');
  });

  it('returns a specific conflict for legacy hash-only keys', async () => {
    const id = Number(getDb().prepare(`
      INSERT INTO consumer_api_keys (user_id, name, key_prefix, key_hash, key_type, key_scope)
      VALUES (?, 'Legacy', 'tuoke-legacy', 'hash', 'universal', 'universal')
    `).run(ownerId).lastInsertRowid);
    const response = await call(app, `/api/consumer-keys/${id}/secret`, ownerToken);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { type: 'consumer_key_not_recoverable' } });
  });
});
