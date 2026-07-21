import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';

export const adminWalletRouter = Router();

const adjustSchema = z.object({
  action: z.enum([
    'add',
    'subtract',
  ]),

  amount: z
    .number()
    .positive()
    .max(1_000_000),

  note: z
    .string()
    .trim()
    .max(500)
    .optional(),
});

function yuanToMicro(
  yuan: number,
): number {
  return Math.round(
    yuan * 1_000_000,
  );
}

function microToYuan(
  micro: number,
): number {
  return Number(
    (
      Number(micro || 0) /
      1_000_000
    ).toFixed(6),
  );
}

/**
 * 查看用户钱包列表
 *
 * GET /api/admin/wallet/users
 *
 * 可选：
 * ?q=email
 */
adminWalletRouter.get(
  '/users',
  (req, res) => {
    const db = getDb();

    const search =
      typeof req.query.q === 'string'
        ? req.query.q
            .trim()
            .toLowerCase()
        : '';

    const rows =
      db.prepare(`
        SELECT
          u.id,
          u.email,
          u.role,
          u.status,

          u.balance_micro
            AS balanceMicro,

          COALESCE(
            (
              SELECT SUM(
                CASE
                  WHEN wt.delta_micro > 0
                  THEN wt.delta_micro
                  ELSE 0
                END
              )
              FROM wallet_transactions wt
              WHERE wt.user_id = u.id
            ),
            0
          ) AS totalAddedMicro,

          COALESCE(
            (
              SELECT SUM(
                CASE
                  WHEN wt.type = 'usage'
                  THEN -wt.delta_micro
                  ELSE 0
                END
              )
              FROM wallet_transactions wt
              WHERE wt.user_id = u.id
            ),
            0
          ) AS totalUsageMicro,

          (
            SELECT MAX(
              wt.created_at
            )
            FROM wallet_transactions wt
            WHERE wt.user_id = u.id
          ) AS lastTransactionAt

        FROM users u

        WHERE
          ? = ''

          OR
          LOWER(u.email)
          LIKE ?

        ORDER BY
          u.id DESC
      `)
        .all(
          search,
          `%${search}%`,
        ) as Array<{
          id: number;
          email: string;
          role: string;
          status: string;
          balanceMicro: number;
          totalAddedMicro: number;
          totalUsageMicro: number;
          lastTransactionAt: string | null;
        }>;

    res.json({
      users:
        rows.map(
          (row) => ({
            id: row.id,
            email: row.email,
            role: row.role,
            status: row.status,

            balance:
              microToYuan(
                row.balanceMicro,
              ),

            total_added:
              microToYuan(
                row.totalAddedMicro,
              ),

            total_usage:
              microToYuan(
                row.totalUsageMicro,
              ),

            last_transaction_at:
              row.lastTransactionAt,
          }),
        ),
    });
  },
);

/**
 * 管理员手动调整余额
 *
 * POST /api/admin/wallet/users/:id/adjust
 *
 * 加余额：
 *
 * {
 *   "action": "add",
 *   "amount": 100,
 *   "note": "Manual recharge"
 * }
 *
 * 扣余额：
 *
 * {
 *   "action": "subtract",
 *   "amount": 10,
 *   "note": "Correction"
 * }
 */
adminWalletRouter.post(
  '/users/:id/adjust',
  (req, res) => {
    const userId =
      Number(
        req.params.id,
      );

    if (
      !Number.isInteger(userId) ||
      userId <= 0
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
      adjustSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            'Invalid wallet adjustment',

          type:
            'validation_error',
        },
      });

      return;
    }

    const amountMicro =
      yuanToMicro(
        parsed.data.amount,
      );

    if (
      !Number.isSafeInteger(
        amountMicro,
      ) ||
      amountMicro <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid amount',

          type:
            'validation_error',
        },
      });

      return;
    }

    const db = getDb();

    try {
      const result =
        db.transaction(() => {
          const user =
            db.prepare(`
              SELECT
                id,
                email,
                balance_micro
                  AS balanceMicro
              FROM users
              WHERE id = ?
            `)
              .get(userId) as
              | {
                  id: number;
                  email: string;
                  balanceMicro: number;
                }
              | undefined;

          if (!user) {
            return {
              kind:
                'not_found' as const,
            };
          }

          const deltaMicro =
            parsed.data.action ===
            'add'
              ? amountMicro
              : -amountMicro;

          const balanceAfterMicro =
            user.balanceMicro +
            deltaMicro;

          if (
            balanceAfterMicro < 0
          ) {
            return {
              kind: 'insufficient_balance' as const,

              balanceMicro:
                user.balanceMicro,
            };
          }

          if (
            !Number.isSafeInteger(
              balanceAfterMicro,
            )
          ) {
            throw new Error(
              'Wallet balance exceeds safe integer range',
            );
          }

          db.prepare(`
            UPDATE users
            SET balance_micro = ?
            WHERE id = ?
          `)
            .run(
              balanceAfterMicro,
              userId,
            );

          db.prepare(`
            INSERT INTO
              wallet_transactions
              (
                user_id,
                type,
                delta_micro,
                balance_after_micro,
                note
              )

            VALUES (
              ?,
              'admin_adjustment',
              ?,
              ?,
              ?
            )
          `)
            .run(
              userId,
              deltaMicro,
              balanceAfterMicro,
              parsed.data.note ||
                (
                  parsed.data.action ===
                  'add'
                    ? 'Admin added balance'
                    : 'Admin deducted balance'
                ),
            );

          return {
            kind:
              'success' as const,

            email:
              user.email,

            balanceMicro:
              balanceAfterMicro,

            deltaMicro,
          };
        })();

      if (
        result.kind ===
        'not_found'
      ) {
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

      if (
        result.kind ===
        'insufficient_balance'
      ) {
        res.status(400).json({
          error: {
            message:
              'Insufficient wallet balance',

            type:
              'insufficient_balance',

            balance:
              microToYuan(
                result.balanceMicro,
              ),
          },
        });

        return;
      }

      res.json({
        success: true,

        user: {
          id:
            userId,

          email:
            result.email,

          balance:
            microToYuan(
              result.balanceMicro,
            ),
        },

        adjustment: {
          action:
            parsed.data.action,

          amount:
            parsed.data.amount,

          delta:
            microToYuan(
              result.deltaMicro,
            ),
        },
      });
    } catch (error) {
      console.error(
        'Failed to adjust wallet:',
        error,
      );

      res.status(500).json({
        error: {
          message:
            'Failed to adjust wallet',

          type:
            'internal_error',
        },
      });
    }
  },
);

/**
 * 查看指定用户资金流水
 *
 * GET /api/admin/wallet/users/:id/transactions
 */
adminWalletRouter.get(
  '/users/:id/transactions',
  (req, res) => {
    const userId =
      Number(
        req.params.id,
      );

    if (
      !Number.isInteger(userId) ||
      userId <= 0
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

    const db = getDb();

    const user =
      db.prepare(`
        SELECT
          id,
          email,
          balance_micro
            AS balanceMicro
        FROM users
        WHERE id = ?
      `)
        .get(userId) as
        | {
            id: number;
            email: string;
            balanceMicro: number;
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

    const rows =
      db.prepare(`
        SELECT
          id,
          type,

          delta_micro
            AS deltaMicro,

          balance_after_micro
            AS balanceAfterMicro,

          request_id
            AS requestId,

          platform,

          model_id
            AS modelId,

          input_tokens
            AS inputTokens,

          output_tokens
            AS outputTokens,

          multiplier_milli
            AS multiplierMilli,

          note,

          created_at
            AS createdAt

        FROM wallet_transactions

        WHERE user_id = ?

        ORDER BY
          id DESC

        LIMIT 500
      `)
        .all(userId) as Array<{
          id: number;
          type: string;
          deltaMicro: number;
          balanceAfterMicro: number;
          requestId: number | null;
          platform: string | null;
          modelId: string | null;
          inputTokens: number;
          outputTokens: number;
          multiplierMilli: number | null;
          note: string | null;
          createdAt: string;
        }>;

    res.json({
      user: {
        id:
          user.id,

        email:
          user.email,

        balance:
          microToYuan(
            user.balanceMicro,
          ),
      },

      transactions:
        rows.map(
          (row) => ({
            id:
              row.id,

            type:
              row.type,

            delta:
              microToYuan(
                row.deltaMicro,
              ),

            balance_after:
              microToYuan(
                row.balanceAfterMicro,
              ),

            request_id:
              row.requestId,

            platform:
              row.platform,

            model_id:
              row.modelId,

            input_tokens:
              Number(
                row.inputTokens || 0,
              ),

            output_tokens:
              Number(
                row.outputTokens || 0,
              ),

            multiplier:
              row.multiplierMilli ===
              null
                ? null
                : Number(
                    (
                      row.multiplierMilli /
                      1000
                    ).toFixed(3),
                  ),

            note:
              row.note,

            created_at:
              row.createdAt,
          }),
        ),
    });
  },
);