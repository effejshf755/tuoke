import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate/runner.js';
import { createConsumerApiKey, revokeConsumerApiKey, validateConsumerApiKey } from '../../services/consumer-api-keys.js';

describe('consumer API keys', () => {
  it('creates, validates, records usage, and rejects revoked keys', async () => {
    const db = new Database(':memory:');
    await runMigrations(db, 'up');
    db.prepare("INSERT INTO users (email, password_hash) VALUES ('key-user@example.com', 'test')").run();
    const created = createConsumerApiKey(db, 1, 'CLI');
    expect(created.key).toMatch(/^tuoke-[A-Za-z0-9_-]{43}$/);
    expect(db.prepare('SELECT key_hash, key_prefix FROM consumer_api_keys').get()).toMatchObject({ key_prefix: created.key.slice(0, 14) });
    expect(validateConsumerApiKey(db, created.key)?.userId).toBe(1);
    expect(validateConsumerApiKey(db, `${created.key}x`)).toBeNull();
    expect(revokeConsumerApiKey(db, created.record.id, 1)).toBe(true);
    expect(validateConsumerApiKey(db, created.key)).toBeNull();
    db.close();
  });
});
