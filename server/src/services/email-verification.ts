import crypto from 'crypto';
import { getDb } from '../db/index.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  if (aBuffer.length !== bBuffer.length) return false;

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function isEmailRegistered(email: string): boolean {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(normalizeEmail(email));

  return !!row;
}

export function createRegistrationCode(email: string): string {
  const db = getDb();
  const normalized = normalizeEmail(email);

  if (isEmailRegistered(normalized)) {
    const err = new Error('An account with that email already exists') as Error & {
      code?: string;
    };
    err.code = 'email_taken';
    throw err;
  }

  const latest = db.prepare(`
    SELECT created_at
    FROM email_verification_codes
    WHERE email = ? AND purpose = 'register'
    ORDER BY id DESC
    LIMIT 1
  `).get(normalized) as { created_at: string } | undefined;

  if (latest) {
    const createdAt = new Date(latest.created_at).getTime();

    if (Number.isFinite(createdAt) && Date.now() - createdAt < SEND_COOLDOWN_MS) {
      const err = new Error('Please wait before requesting another code') as Error & {
        code?: string;
      };
      err.code = 'send_cooldown';
      throw err;
    }
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

  // 使之前尚未使用的注册验证码失效。
  db.prepare(`
    UPDATE email_verification_codes
    SET used_at = ?
    WHERE email = ?
      AND purpose = 'register'
      AND used_at IS NULL
  `).run(now.toISOString(), normalized);

  db.prepare(`
    INSERT INTO email_verification_codes
      (email, code_hash, purpose, expires_at, created_at)
    VALUES (?, ?, 'register', ?, ?)
  `).run(
    normalized,
    hashCode(code),
    expiresAt.toISOString(),
    now.toISOString(),
  );

  return code;
}

export function verifyRegistrationCode(email: string, code: string): boolean {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const row = db.prepare(`
    SELECT id, code_hash, expires_at, attempts
    FROM email_verification_codes
    WHERE email = ?
      AND purpose = 'register'
      AND used_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(normalized) as {
    id: number;
    code_hash: string;
    expires_at: string;
    attempts: number;
  } | undefined;

  if (!row) return false;

  if (row.attempts >= MAX_ATTEMPTS) {
    return false;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return false;
  }

  const matches = safeEqual(row.code_hash, hashCode(code));

  if (!matches) {
    db.prepare(`
      UPDATE email_verification_codes
      SET attempts = attempts + 1
      WHERE id = ?
    `).run(row.id);

    return false;
  }

  db.prepare(`
    UPDATE email_verification_codes
    SET used_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), row.id);

  return true;
}