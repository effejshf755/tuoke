import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate/runner.js';
import { createConsumerApiKey, getConsumerApiKeySecret, revokeConsumerApiKey, validateConsumerApiKey } from '../../services/consumer-api-keys.js';

describe('consumer API keys', () => {
  it('creates, validates, records usage, and rejects revoked keys', async () => {
    const db = new Database(':memory:');
    await runMigrations(db, 'up');
    db.prepare("INSERT INTO users (email, password_hash) VALUES ('key-user@example.com', 'test')").run();
    const created = createConsumerApiKey(db, 1, 'CLI');
    expect(created.key).toMatch(/^tuoke-[A-Za-z0-9_-]{43}$/);
    expect(db.prepare('SELECT key_hash, key_prefix, key_encrypted FROM consumer_api_keys').get()).toMatchObject({
      key_prefix: created.key.slice(0, 14),
      key_encrypted: expect.any(String),
    });
    expect(getConsumerApiKeySecret(db, created.record.id, 1)).toEqual({ status: 'ok', key: created.key });
    expect(getConsumerApiKeySecret(db, created.record.id, 2)).toEqual({ status: 'not_found' });
    expect(validateConsumerApiKey(db, created.key)?.userId).toBe(1);
    expect(validateConsumerApiKey(db, `${created.key}x`)).toBeNull();
    expect(revokeConsumerApiKey(db, created.record.id, 1)).toBe(true);
    expect(validateConsumerApiKey(db, created.key)).toBeNull();
    db.close();
  });

  it('reports legacy hash-only keys as not recoverable', async () => {
    const db = new Database(':memory:');
    await runMigrations(db, 'up');
    db.prepare("INSERT INTO users (email, password_hash) VALUES ('legacy-key@example.com', 'test')").run();
    const id = Number(db.prepare(`
      INSERT INTO consumer_api_keys (user_id, name, key_prefix, key_hash, key_type, key_scope)
      VALUES (1, 'Legacy', 'tuoke-legacy', 'hash', 'universal', 'universal')
    `).run().lastInsertRowid);
    expect(getConsumerApiKeySecret(db, id, 1)).toEqual({ status: 'not_recoverable' });
    db.close();
  });
});
