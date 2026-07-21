import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';

export const adminUsersRouter = Router();

const updateUserSchema = z.object({
  status: z
    .enum(['active', 'disabled'])
    .optional(),

  monthly_token_limit: z
    .number()
    .int()
    .min(0)
    .optional(),
});
const rpmSchema = z.object({ rate_limit_rpm: z.number().int().min(0).max(100000).nullable() });
adminUsersRouter.patch('/:userId/keys/:keyId/rpm', (req, res) => {
  const userId = Number(req.params.userId), keyId = Number(req.params.keyId);
  const parsed = rpmSchema.safeParse(req.body);
  if (!Number.isInteger(userId) || !Number.isInteger(keyId) || !parsed.success) { res.status(400).json({ error: { message: 'Invalid RPM', type: 'validation_error' } }); return; }
  const result = getDb().prepare('UPDATE consumer_api_keys SET rate_limit_rpm = ? WHERE id = ? AND user_id = ?').run(parsed.data.rate_limit_rpm, keyId, userId);
  if (result.changes !== 1) { res.status(404).json({ error: { message: 'API key not found', type: 'not_found' } }); return; }
  res.json({ success: true, rate_limit_rpm: parsed.data.rate_limit_rpm });
});

/**
 * 管理员获取用户列表
 *
 * GET /api/admin/users
 * GET /api/admin/users?q=test@example.com
 */
adminUsersRouter.get(
  '/',
  (req, res) => {
    const db = getDb();

    const search =
      typeof req.query.q === 'string'
        ? req.query.q.trim().toLowerCase()
        : '';

    const now = Date.now();

    const rows = db
      .prepare(`
        SELECT
          u.id,
          u.email,
          u.role,
          u.status,
          u.created_at,
          u.monthly_token_limit,

          COALESCE(
            (
              SELECT SUM(
                COALESCE(r.input_tokens, 0) +
                COALESCE(r.output_tokens, 0)
              )
              FROM requests r
              WHERE r.consumer_user_id = u.id
                AND r.created_at >=
                  strftime(
                    '%Y-%m-01 00:00:00',
                    'now'
                  )
            ),
            0
          ) AS monthly_used_tokens,

          (
            SELECT COUNT(*)
            FROM consumer_api_keys k
            WHERE k.user_id = u.id
          ) AS api_key_count,

          (
            SELECT COUNT(*)
            FROM consumer_api_keys k
            WHERE k.user_id = u.id
              AND k.status = 'active'
          ) AS active_api_key_count,

          (
            SELECT MAX(r.created_at)
            FROM requests r
            WHERE r.consumer_user_id = u.id
          ) AS last_request_at,

          (
            SELECT COUNT(*)
            FROM sessions s
            WHERE s.user_id = u.id
              AND s.expires_at_ms > ?
          ) AS active_session_count

          ,(
            SELECT json_group_array(json_object(
              'id', k.id,
              'name', k.name,
              'key_prefix', k.key_prefix,
              'status', k.status,
              'enabled', k.enabled,
              'last_used_at', k.last_used_at,
              'rate_limit_rpm', k.rate_limit_rpm,
              'request_count', (SELECT COUNT(*) FROM requests r2 WHERE r2.consumer_api_key_id = k.id),
              'input_tokens', (SELECT COALESCE(SUM(r3.input_tokens), 0) FROM requests r3 WHERE r3.consumer_api_key_id = k.id),
              'output_tokens', (SELECT COALESCE(SUM(r4.output_tokens), 0) FROM requests r4 WHERE r4.consumer_api_key_id = k.id)
            ))
            FROM consumer_api_keys k
            WHERE k.user_id = u.id
              AND k.status <> 'revoked'
          ) AS api_keys

        FROM users u

        WHERE
          ? = ''
          OR LOWER(u.email)
             LIKE '%' || ? || '%'

        ORDER BY
          u.id DESC
      `)
      .all(
        now,
        search,
        search,
      );

    res.json({
      users: rows,
    });
  },
);

/**
 * 管理员修改用户
 *
 * PATCH /api/admin/users/:id
 *
 * 支持：
 * - monthly_token_limit
 * - status
 */
adminUsersRouter.patch(
  '/:id',
  (req, res) => {
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid user id',
          type:
            'validation_error',
        },
      });

      return;
    }

    const parsed =
      updateUserSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            parsed.error.errors
              .map(
                (error) =>
                  error.message,
              )
              .join(', '),

          type:
            'validation_error',
        },
      });

      return;
    }

    const actor = (
      req as unknown as Request & {
        user: {
          userId: number;
        };
      }
    ).user;

    const db = getDb();

    const current = db
      .prepare(`
        SELECT
          id,
          email,
          role,
          status
        FROM users
        WHERE id = ?
      `)
      .get(id) as
      | {
          id: number;
          email: string;
          role: string;
          status: string;
        }
      | undefined;

    if (!current) {
      res.status(404).json({
        error: {
          message:
            'User not found',
          type:
            'not_found',
        },
      });

      return;
    }

    const {
      status,
      monthly_token_limit,
    } = parsed.data;

    /**
     * 管理员不能禁用自己。
     */
    if (
      status === 'disabled' &&
      actor.userId === id
    ) {
      res.status(400).json({
        error: {
          message:
            'You cannot disable yourself',
          type:
            'invalid_operation',
        },
      });

      return;
    }

    /**
     * 现阶段不允许禁用管理员账号。
     */
    if (
      status === 'disabled' &&
      current.role === 'admin'
    ) {
      res.status(400).json({
        error: {
          message:
            'Administrators cannot be disabled',
          type:
            'invalid_operation',
        },
      });

      return;
    }

    const transaction =
      db.transaction(() => {
        if (
          monthly_token_limit !==
          undefined
        ) {
          db.prepare(`
            UPDATE users
            SET monthly_token_limit = ?
            WHERE id = ?
          `).run(
            monthly_token_limit,
            id,
          );
        }

        if (status) {
          db.prepare(`
            UPDATE users
            SET status = ?
            WHERE id = ?
          `).run(
            status,
            id,
          );

          /**
           * 用户被禁用时，
           * 立即删除所有 Dashboard Session。
           */
          if (
            status === 'disabled'
          ) {
            db.prepare(`
              DELETE FROM sessions
              WHERE user_id = ?
            `).run(id);
          }
        }
      });

    transaction();

    res.json({
      success: true,
    });
  },
);

/**
 * 管理员强制注销用户所有登录设备
 *
 * POST /api/admin/users/:id/logout-all
 */
adminUsersRouter.post(
  '/:id/logout-all',
  (req, res) => {
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid user id',
          type:
            'validation_error',
        },
      });

      return;
    }

    const actor = (
      req as unknown as Request & {
        user: {
          userId: number;
        };
      }
    ).user;

    /**
     * 防止管理员误操作把自己踢下线。
     */
    if (actor.userId === id) {
      res.status(400).json({
        error: {
          message:
            'You cannot force logout yourself',
          type:
            'invalid_operation',
        },
      });

      return;
    }

    const db = getDb();

    const user = db
      .prepare(`
        SELECT id
        FROM users
        WHERE id = ?
      `)
      .get(id);

    if (!user) {
      res.status(404).json({
        error: {
          message:
            'User not found',
          type:
            'not_found',
        },
      });

      return;
    }

    const result = db
      .prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
      `)
      .run(id);

    res.json({
      success: true,

      logged_out_sessions:
        result.changes,
    });
  },
);
