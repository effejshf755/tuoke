import crypto from 'crypto';
import type { Db } from '../db/types.js';
import { decrypt, encrypt, initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import { bindNewCodexPoolKey } from './resource-member-key.js';

const KEY_PREFIX = 'tuoke-';
const RANDOM_BYTES = 32;

export type ConsumerApiKeyType = 'universal' | 'codex_pool' | 'resource_subpool';

export interface ConsumerApiKey {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  keyType: ConsumerApiKeyType;

  status:
    | 'active'
    | 'revoked';

  enabled: 0 | 1;

  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rateLimitRpm: number | null;

  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CreatedConsumerApiKey {
  key: string;
  record: ConsumerApiKey;
}

export type ConsumerApiKeySecretResult =
  | { status: 'ok'; key: string }
  | { status: 'not_found' }
  | { status: 'not_recoverable' };

interface StoredKey {
  id: number;
  userId: number;
  name: string;
  keyPrefix: string;
  keyHash: string;
  keyType: ConsumerApiKeyType;

  status:
    | 'active'
    | 'revoked';

  enabled: number;

  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rateLimitRpm?: number | null;

  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function hashKey(
  key: string,
): string {
  return crypto
    .createHash('sha256')
    .update(key, 'utf8')
    .digest('hex');
}

function toRecord(
  row: StoredKey,
): ConsumerApiKey {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyType: row.keyType,
    status: row.status,

    enabled:
      row.enabled === 1
        ? 1
        : 0,

    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    rateLimitRpm: row.rateLimitRpm == null ? null : Number(row.rateLimitRpm),

    requestCount:
      Number(
        row.requestCount ?? 0,
      ),

    inputTokens:
      Number(
        row.inputTokens ?? 0,
      ),

    outputTokens:
      Number(
        row.outputTokens ?? 0,
      ),

    totalTokens:
      Number(
        row.totalTokens ?? 0,
      ),
  };
}

/**
 * 用户本月 Token 使用量
 */
export function getConsumerMonthlyUsage(
  db: Db,
  userId: number,
): {
  usedTokens: number;
  limit: number;
} {
  const row = db
    .prepare(`
      SELECT
        u.monthly_token_limit
          AS limit,

        COALESCE(
          SUM(
            CASE
              WHEN r.created_at >=
                strftime(
                  '%Y-%m-01 00:00:00',
                  'now'
                )
              THEN
                COALESCE(
                  r.input_tokens,
                  0
                )
                +
                COALESCE(
                  r.output_tokens,
                  0
                )
              ELSE 0
            END
          ),
          0
        ) AS usedTokens

      FROM users u

      LEFT JOIN requests r
        ON r.consumer_user_id =
           u.id

      WHERE u.id = ?

      GROUP BY u.id
    `)
    .get(userId) as
    | {
        usedTokens: number;
        limit: number;
      }
    | undefined;

  return {
    usedTokens:
      Number(
        row?.usedTokens ?? 0,
      ),

    limit:
      Number(
        row?.limit ?? 0,
      ),
  };
}

/**
 * 获取用户全部 API Key
 *
 * 同时返回每把 Key 的累计统计：
 * - 请求次数
 * - Input Tokens
 * - Output Tokens
 * - Total Tokens
 */
export function listConsumerApiKeys(
  db: Db,
  userId: number,
): ConsumerApiKey[] {
  const rows = db
    .prepare(`
      SELECT
        k.id,
        k.user_id
          AS userId,

        k.name,

        k.key_prefix
          AS keyPrefix,

        k.key_hash
          AS keyHash,

        k.key_scope
          AS keyType,

        k.status,
        k.enabled,

        k.created_at
          AS createdAt,

        k.last_used_at
          AS lastUsedAt,

        k.expires_at
          AS expiresAt,
        k.rate_limit_rpm AS rateLimitRpm,

        (
          SELECT COUNT(*)

          FROM requests r

          WHERE
            r.consumer_api_key_id =
            k.id
        )
          AS requestCount,

        COALESCE(
          (
            SELECT SUM(
              COALESCE(
                r.input_tokens,
                0
              )
            )

            FROM requests r

            WHERE
              r.consumer_api_key_id =
              k.id
          ),
          0
        )
          AS inputTokens,

        COALESCE(
          (
            SELECT SUM(
              COALESCE(
                r.output_tokens,
                0
              )
            )

            FROM requests r

            WHERE
              r.consumer_api_key_id =
              k.id
          ),
          0
        )
          AS outputTokens,

        COALESCE(
          (
            SELECT SUM(
              COALESCE(
                r.input_tokens,
                0
              )
              +
              COALESCE(
                r.output_tokens,
                0
              )
            )

            FROM requests r

            WHERE
              r.consumer_api_key_id =
              k.id
          ),
          0
        )
          AS totalTokens

      FROM consumer_api_keys k

      WHERE
        k.user_id = ?
        AND k.status = 'active'

      ORDER BY
        k.id DESC
    `)
    .all(
      userId,
    ) as StoredKey[];

  return rows.map(
    toRecord,
  );
}

/**
 * 创建新的 Tuoke API Key
 *
 * expiresAt:
 * - null = 永久
 * - ISO 时间 = 到期时间
 */
export function createConsumerApiKey(
  db: Db,
  userId: number,
  name: string,
  expiresAt?: string | null,
  keyType: ConsumerApiKeyType = 'universal',
): CreatedConsumerApiKey {
  const key =
    `${KEY_PREFIX}${
      crypto
        .randomBytes(
          RANDOM_BYTES,
        )
        .toString(
          'base64url',
        )
    }`;

  const keyPrefix =
    key.slice(
      0,
      KEY_PREFIX.length + 8,
    );

  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey(db);
  }
  const encryptedKey = encrypt(key);

  const result = db
    .prepare(`
      INSERT INTO
        consumer_api_keys
        (
          user_id,
          name,
          key_prefix,
          key_hash,
          key_encrypted,
          key_iv,
          key_auth_tag,
          expires_at,
          enabled,
          key_type,
          key_scope
        )

      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        1,
        ?,
        ?
      )
    `)
    .run(
      userId,
      name,
      keyPrefix,
      hashKey(key),
      encryptedKey.encrypted,
      encryptedKey.iv,
      encryptedKey.authTag,
      expiresAt ?? null,
      keyType === 'resource_subpool' ? 'codex_pool' : keyType,
      keyType,
    );

  const row = db
    .prepare(`
      SELECT
        id,

        user_id
          AS userId,

        name,

        key_prefix
          AS keyPrefix,

        key_hash
          AS keyHash,

        key_scope
          AS keyType,

        status,
        enabled,

        created_at
          AS createdAt,

        last_used_at
          AS lastUsedAt,

        expires_at
          AS expiresAt,
        rate_limit_rpm AS rateLimitRpm,

        0 AS requestCount,
        0 AS inputTokens,
        0 AS outputTokens,
        0 AS totalTokens

      FROM consumer_api_keys

      WHERE id = ?
    `)
    .get(
      result.lastInsertRowid,
    ) as StoredKey;

  if (keyType === 'resource_subpool') {
    bindNewCodexPoolKey(db, userId, Number(result.lastInsertRowid));
  }

  return {
    key,
    record:
      toRecord(row),
  };
}

export function getConsumerApiKeySecret(
  db: Db,
  id: number,
  userId: number,
): ConsumerApiKeySecretResult {
  const row = db.prepare(`
    SELECT key_encrypted AS encrypted, key_iv AS iv, key_auth_tag AS authTag
    FROM consumer_api_keys
    WHERE id = ? AND user_id = ?
  `).get(id, userId) as { encrypted: string | null; iv: string | null; authTag: string | null } | undefined;

  if (!row) return { status: 'not_found' };
  if (!row.encrypted || !row.iv || !row.authTag) return { status: 'not_recoverable' };
  if (!isEncryptionKeyInitialized()) initEncryptionKey(db);

  return { status: 'ok', key: decrypt(row.encrypted, row.iv, row.authTag) };
}

/**
 * 验证消费者 API Key
 *
 * 必须同时满足：
 *
 * status = active
 * enabled = 1
 * 用户账号 active
 * 未过期
 */
export function validateConsumerApiKey(
  db: Db,
  key: string,
): ConsumerApiKey | null {
  if (
    !key.startsWith(
      KEY_PREFIX,
    )
  ) {
    return null;
  }

  const keyHash =
    hashKey(key);

  const keyPrefix =
    key.slice(
      0,
      KEY_PREFIX.length + 8,
    );

  const rows = db
    .prepare(`
      SELECT
        k.id,

        k.user_id
          AS userId,

        k.name,

        k.key_prefix
          AS keyPrefix,

        k.key_hash
          AS keyHash,

        k.key_scope
          AS keyType,

        k.status,
        k.enabled,

        k.created_at
          AS createdAt,

        k.last_used_at
          AS lastUsedAt,

        k.expires_at
          AS expiresAt,
        k.rate_limit_rpm AS rateLimitRpm,

        0 AS requestCount,
        0 AS inputTokens,
        0 AS outputTokens,
        0 AS totalTokens

      FROM consumer_api_keys k

      JOIN users u
        ON u.id =
           k.user_id

      WHERE
        k.key_prefix = ?

        AND
        k.status =
        'active'

        AND
        k.enabled = 1

        AND
        u.status =
        'active'
    `)
    .all(
      keyPrefix,
    ) as StoredKey[];

  const row =
    rows.find(
      (candidate) => {
        const actual =
          Buffer.from(
            candidate.keyHash,
            'hex',
          );

        const expected =
          Buffer.from(
            keyHash,
            'hex',
          );

        return (
          actual.length ===
            expected.length
          &&
          crypto.timingSafeEqual(
            actual,
            expected,
          )
        );
      },
    );

  if (!row) {
    return null;
  }

  /**
   * 到期 Key 自动拒绝调用
   */
  if (
    row.expiresAt !== null
    &&
    Date.parse(
      row.expiresAt,
    ) <= Date.now()
  ) {
    return null;
  }

  const now =
    new Date()
      .toISOString();

  db.prepare(`
    UPDATE
      consumer_api_keys

    SET
      last_used_at = ?

    WHERE
      id = ?
  `)
    .run(
      now,
      row.id,
    );

  return toRecord({
    ...row,
    lastUsedAt: now,
  });
}

/**
 * 暂停 / 恢复 API Key
 */
export function setConsumerApiKeyEnabled(
  db: Db,
  id: number,
  userId: number,
  enabled: boolean,
): boolean {
  const result = db
    .prepare(`
      UPDATE
        consumer_api_keys

      SET
        enabled = ?

      WHERE
        id = ?

        AND
        user_id = ?

        AND
        status =
        'active'
    `)
    .run(
      enabled
        ? 1
        : 0,

      id,
      userId,
    );

  return (
    result.changes > 0
  );
}

/**
 * 永久撤销 API Key
 *
 * 撤销后不能再次恢复。
 */
export function revokeConsumerApiKey(
  db: Db,
  id: number,
  userId?: number,
): boolean {
  const sql =
    userId === undefined
      ? `
          UPDATE
            consumer_api_keys

          SET
            status =
              'revoked',

            enabled = 0

          WHERE
            id = ?
        `
      : `
          UPDATE
            consumer_api_keys

          SET
            status =
              'revoked',

            enabled = 0

          WHERE
            id = ?

            AND
            user_id = ?
        `;

  const result =
    userId === undefined
      ? db
          .prepare(sql)
          .run(id)
      : db
          .prepare(sql)
          .run(
            id,
            userId,
          );

  return (
    result.changes > 0
  );
}
