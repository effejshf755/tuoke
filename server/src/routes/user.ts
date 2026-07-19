import crypto from 'crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import {
  hashPassword,
  verifyPassword,
} from '../lib/password.js';

import {
  getConsumerMonthlyUsage,
} from '../services/consumer-api-keys.js';

export const userRouter = Router();

const changePasswordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, 'Current password is required'),

  newPassword: z
    .string()
    .min(
      8,
      'New password must be at least 8 characters',
    ),
});

function getUserId(req: Request): number {
  return (
    req as Request & {
      user: {
        userId: number;
      };
    }
  ).user.userId;
}

function getBearerToken(
  req: Request,
): string | undefined {
  return (
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      '',
    ) ??
    (req.headers[
      'x-dashboard-token'
    ] as string | undefined)
  );
}

function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

/**
 * 当前用户用量
 */
userRouter.get('/usage', (req, res) => {
  const userId = getUserId(req);

  const row = getDb()
    .prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0)
          AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0)
          AS completion_tokens,
        COALESCE(
          SUM(input_tokens + output_tokens),
          0
        ) AS total_tokens
      FROM requests
      WHERE consumer_user_id = ?
    `)
    .get(userId) as {
      total_requests: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };

  const monthly =
    getConsumerMonthlyUsage(
      getDb(),
      userId,
    );

  res.json({
    ...row,

    monthly_used_tokens:
      monthly.usedTokens,

    monthly_token_limit:
      monthly.limit,

    monthly_remaining_tokens:
      Math.max(
        0,
        monthly.limit -
          monthly.usedTokens,
      ),
  });
});

/**
 * 当前可用模型
 */
userRouter.get('/models', (_req, res) => {
  const rows = getDb()
    .prepare(`
      SELECT
        model_id,
        display_name,
        platform,
        context_window,
        enabled
      FROM models
      WHERE enabled = 1
      ORDER BY
        intelligence_rank ASC,
        model_id ASC
    `)
    .all();

  res.json({
    models: [
      {
        model_id: 'auto',
        display_name: 'Auto',
        platform: 'Tuoke API',
        context_window: null,
        enabled: 1,
      },

      ...rows,
    ],
  });
});

/**
 * 修改当前账户密码
 *
 * POST /api/user/password
 *
 * {
 *   "currentPassword": "old-password",
 *   "newPassword": "new-password"
 * }
 */
userRouter.post(
  '/password',
  (req, res) => {
    const parsed =
      changePasswordSchema.safeParse(
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

    const userId =
      getUserId(req);

    const {
      currentPassword,
      newPassword,
    } = parsed.data;

    const db = getDb();

    const user = db
      .prepare(`
        SELECT
          id,
          password_hash
        FROM users
        WHERE id = ?
      `)
      .get(userId) as
      | {
          id: number;
          password_hash: string;
        }
      | undefined;

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

    /**
     * 必须先验证当前密码。
     */
    if (
      !verifyPassword(
        currentPassword,
        user.password_hash,
      )
    ) {
      res.status(400).json({
        error: {
          message:
            'Current password is incorrect',

          type:
            'invalid_password',
        },
      });

      return;
    }

    /**
     * 不允许新旧密码相同。
     */
    if (
      verifyPassword(
        newPassword,
        user.password_hash,
      )
    ) {
      res.status(400).json({
        error: {
          message:
            'New password must be different from current password',

          type:
            'same_password',
        },
      });

      return;
    }

    const currentToken =
      getBearerToken(req);

    const transaction =
      db.transaction(() => {
        /**
         * 修改密码。
         */
        db.prepare(`
          UPDATE users
          SET password_hash = ?
          WHERE id = ?
        `).run(
          hashPassword(
            newPassword,
          ),
          userId,
        );

        /**
         * 注销其他设备的登录状态。
         *
         * 当前浏览器保持登录，
         * 其他旧 Session 全部失效。
         */
        if (currentToken) {
          const currentTokenHash =
            sha256(
              currentToken,
            );

          db.prepare(`
            DELETE FROM sessions
            WHERE user_id = ?
              AND token_hash <> ?
          `).run(
            userId,
            currentTokenHash,
          );
        } else {
          db.prepare(`
            DELETE FROM sessions
            WHERE user_id = ?
          `).run(userId);
        }
      });

    transaction();

    res.json({
      success: true,

      message:
        'Password changed successfully',
    });
  },
);