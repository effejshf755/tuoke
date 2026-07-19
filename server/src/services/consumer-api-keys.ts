import crypto from 'crypto';
import type { Db } from '../db/types.js';

const KEY_PREFIX = 'tuoke-';
const RANDOM_BYTES = 32;

export interface ConsumerApiKey {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreatedConsumerApiKey {
  key: string;
  record: ConsumerApiKey;
}

export function getConsumerMonthlyUsage(db: Db, userId: number): { usedTokens: number; limit: number } {
  const row = db.prepare(`
    SELECT u.monthly_token_limit AS limit,
           COALESCE(SUM(CASE WHEN r.created_at >= strftime('%Y-%m-01 00:00:00', 'now') THEN r.input_tokens + r.output_tokens ELSE 0 END), 0) AS usedTokens
      FROM users u LEFT JOIN requests r ON r.consumer_user_id = u.id
     WHERE u.id = ? GROUP BY u.id
  `).get(userId) as { usedTokens: number; limit: number };
  return row;
}

export function listConsumerApiKeys(db: Db, userId: number): ConsumerApiKey[] {
  return db.prepare(`
    SELECT id, user_id AS userId, name, key_prefix AS keyPrefix, key_hash AS keyHash,
           status, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt
      FROM consumer_api_keys WHERE user_id = ? ORDER BY id DESC
  `).all(userId).map(row => toRecord(row as StoredKey));
}

interface StoredKey extends ConsumerApiKey {
  keyHash: string;
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function toRecord(row: StoredKey): ConsumerApiKey {
  const { keyHash: _keyHash, ...record } = row;
  return record;
}

export function createConsumerApiKey(db: Db, userId: number, name: string, expiresAt?: string | null): CreatedConsumerApiKey {
  const key = `${KEY_PREFIX}${crypto.randomBytes(RANDOM_BYTES).toString('base64url')}`;
  const keyPrefix = key.slice(0, KEY_PREFIX.length + 8);
  const result = db.prepare(`
    INSERT INTO consumer_api_keys (user_id, name, key_prefix, key_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, name, keyPrefix, hashKey(key), expiresAt ?? null);
  const row = db.prepare(`
    SELECT id, user_id AS userId, name, key_prefix AS keyPrefix, key_hash AS keyHash,
           status, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt
      FROM consumer_api_keys WHERE id = ?
  `).get(result.lastInsertRowid) as StoredKey;
  return { key, record: toRecord(row) };
}

export function validateConsumerApiKey(db: Db, key: string): ConsumerApiKey | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashKey(key);
  const rows = db.prepare(`
    SELECT id, user_id AS userId, name, key_prefix AS keyPrefix, key_hash AS keyHash,
           status, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt
      FROM consumer_api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_prefix = ? AND k.status = 'active' AND u.status = 'active'
  `).all(key.slice(0, KEY_PREFIX.length + 8)) as StoredKey[];
  const row = rows.find(candidate => {
    const actual = Buffer.from(candidate.keyHash, 'hex');
    const expected = Buffer.from(keyHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (!row || (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now())) return null;
  db.prepare("UPDATE consumer_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return toRecord({ ...row, lastUsedAt: new Date().toISOString() });
}

export function revokeConsumerApiKey(db: Db, id: number, userId?: number): boolean {
  const result = db.prepare(
    `UPDATE consumer_api_keys SET status = 'revoked' WHERE id = ?${userId === undefined ? '' : ' AND user_id = ?'}`,
  ).run(...(userId === undefined ? [id] : [id, userId]));
  return result.changes > 0;
}
