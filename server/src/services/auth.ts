import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: number;
  email: string;
  role: 'admin' | 'user';
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const role = userCount() === 0 ? 'admin' : 'user';
  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)')
      .run(normalized, hashPassword(password), role);
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'new_user_bonus_micro'").get() as { value: string } | undefined;
    const bonus = Number(setting?.value ?? 0);
    if (role === 'user' && bonus > 0) {
      const updated = db.prepare('UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?').run(bonus, result.lastInsertRowid);
      if (updated.changes !== 1) throw new Error('Failed to grant registration bonus');
      db.prepare("INSERT INTO wallet_transactions (user_id, type, delta_micro, balance_after_micro, note) VALUES (?, 'bonus', ?, ?, 'New user registration bonus')").run(result.lastInsertRowid, bonus, bonus);
    }
    return Number(result.lastInsertRowid);
  });
  const userId = create();
  return { userId, email: normalized, role };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare("SELECT id, email, password_hash, role, status FROM users WHERE email = ? AND status = 'active'")
    .get(normalizeEmail(email)) as { id: number; email: string; password_hash: string; role: 'admin' | 'user'; status: 'active' | 'disabled' } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email, role: row.role };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token)) as { user_id: number; expires_at_ms: number; email: string; role: 'admin' | 'user'; status: 'active' | 'disabled' } | undefined;
  if (!row) return null;
  if (row.status === 'disabled') return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { userId: row.user_id, email: row.email, role: row.role };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
