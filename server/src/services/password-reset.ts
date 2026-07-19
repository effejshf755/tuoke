import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword } from '../lib/password.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    aBuffer,
    bBuffer,
  );
}

/**
 * 生成找回密码验证码。
 *
 * 返回：
 * - string：邮箱存在，需要发送该验证码
 * - null：邮箱不存在
 *
 * 路由层不要把“邮箱是否存在”告诉客户端，
 * 防止别人通过接口批量查询注册用户。
 */
export function createPasswordResetCode(
  email: string,
): string | null {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const user = db
    .prepare(`
      SELECT id
      FROM users
      WHERE email = ?
    `)
    .get(normalized) as
    | { id: number }
    | undefined;

  if (!user) {
    return null;
  }

  const latest = db
    .prepare(`
      SELECT created_at
      FROM password_reset_codes
      WHERE email = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(normalized) as
    | { created_at: string }
    | undefined;

  if (latest) {
    const createdAt =
      new Date(latest.created_at).getTime();

    if (
      Number.isFinite(createdAt) &&
      Date.now() - createdAt <
        SEND_COOLDOWN_MS
    ) {
      const err = new Error(
        'Please wait before requesting another code',
      ) as Error & {
        code?: string;
      };

      err.code = 'send_cooldown';

      throw err;
    }
  }

  const code = crypto
    .randomInt(0, 1_000_000)
    .toString()
    .padStart(6, '0');

  const now = new Date();

  const expiresAt = new Date(
    now.getTime() + CODE_TTL_MS,
  );

  // 使之前未使用的找回密码验证码全部失效
  db.prepare(`
    UPDATE password_reset_codes
    SET used_at = ?
    WHERE email = ?
      AND used_at IS NULL
  `).run(
    now.toISOString(),
    normalized,
  );

  db.prepare(`
    INSERT INTO password_reset_codes (
      email,
      code_hash,
      expires_at,
      created_at
    )
    VALUES (?, ?, ?, ?)
  `).run(
    normalized,
    hashCode(code),
    expiresAt.toISOString(),
    now.toISOString(),
  );

  return code;
}

/**
 * 验证验证码并修改密码。
 *
 * 成功后：
 * 1. 验证码立即失效
 * 2. 修改密码
 * 3. 删除该用户所有旧 Session
 *
 * 返回：
 * true  = 修改成功
 * false = 验证码错误、过期、已使用或尝试次数过多
 */
export function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string,
): boolean {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const row = db
    .prepare(`
      SELECT
        prc.id,
        prc.code_hash,
        prc.expires_at,
        prc.attempts,
        u.id AS user_id
      FROM password_reset_codes prc
      JOIN users u
        ON u.email = prc.email
      WHERE prc.email = ?
        AND prc.used_at IS NULL
      ORDER BY prc.id DESC
      LIMIT 1
    `)
    .get(normalized) as
    | {
        id: number;
        code_hash: string;
        expires_at: string;
        attempts: number;
        user_id: number;
      }
    | undefined;

  if (!row) {
    return false;
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    return false;
  }

  const expiresAt =
    new Date(row.expires_at).getTime();

  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return false;
  }

  const matches = safeEqual(
    row.code_hash,
    hashCode(code),
  );

  if (!matches) {
    db.prepare(`
      UPDATE password_reset_codes
      SET attempts = attempts + 1
      WHERE id = ?
    `).run(row.id);

    return false;
  }

  const transaction = db.transaction(() => {
    // 验证码立即标记为已使用
    db.prepare(`
      UPDATE password_reset_codes
      SET used_at = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      row.id,
    );

    // 修改新密码
    db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
    `).run(
      hashPassword(newPassword),
      row.user_id,
    );

    // 注销这个账号以前所有登录状态
    db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ?
    `).run(row.user_id);
  });

  transaction();

  return true;
}