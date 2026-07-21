import { Router } from 'express';
import type { Request } from 'express';

import { getDb } from '../db/index.js';

export const userWalletRouter =
  Router();

function getUserId(
  req: Request,
): number {
  return (
    req as Request & {
      user: {
        userId: number;
      };
    }
  ).user.userId;
}

function microToYuan(
  value: number,
): number {
  return value / 1_000_000;
}

/**
 * GET /api/user/wallet
 *
 * Current authenticated user's wallet summary.
 */
userWalletRouter.get(
  '/',
  (req, res) => {
    const userId =
      getUserId(req);

    const db =
      getDb();

    const user =
      db.prepare(`
        SELECT
          id,
          email,

          balance_micro
            AS balanceMicro,

          reserved_balance_micro
            AS reservedBalanceMicro

        FROM users

        WHERE id = ?
      `).get(
        userId,
      ) as
        | {
            id: number;
            email: string;
            balanceMicro: number;
            reservedBalanceMicro: number;
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

    const totals =
      db.prepare(`
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN delta_micro > 0
                THEN delta_micro
                ELSE 0
              END
            ),
            0
          ) AS totalAddedMicro,

          COALESCE(
            SUM(
              CASE
                WHEN type = 'usage'
                  AND delta_micro < 0
                THEN -delta_micro
                ELSE 0
              END
            ),
            0
          ) AS totalUsageMicro,

          COUNT(*) AS transactionCount

        FROM wallet_transactions

        WHERE user_id = ?
      `).get(
        userId,
      ) as {
        totalAddedMicro: number;
        totalUsageMicro: number;
        transactionCount: number;
      };

    const availableMicro =
      Math.max(
        0,
        user.balanceMicro -
          user.reservedBalanceMicro,
      );

    res.json({
      wallet: {
        user_id:
          user.id,

        email:
          user.email,

        balance:
          microToYuan(
            user.balanceMicro,
          ),

        reserved_balance:
          microToYuan(
            user.reservedBalanceMicro,
          ),

        available_balance:
          microToYuan(
            availableMicro,
          ),

        total_added:
          microToYuan(
            totals.totalAddedMicro,
          ),

        total_usage:
          microToYuan(
            totals.totalUsageMicro,
          ),

        transaction_count:
          totals.transactionCount,
      },
    });
  },
);

/**
 * GET /api/user/wallet/transactions
 *
 * Current authenticated user's own wallet history.
 */
userWalletRouter.get(
  '/transactions',
  (req, res) => {
    const userId =
      getUserId(req);

    const db =
      getDb();

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

          input_price_micro_per_million
            AS inputPriceMicroPerMillion,

          output_price_micro_per_million
            AS outputPriceMicroPerMillion,

          note,

          created_at
            AS createdAt

        FROM wallet_transactions

        WHERE user_id = ?

        ORDER BY id DESC

        LIMIT 500
      `).all(
        userId,
      ) as Array<{
        id: number;

        type: string;

        deltaMicro: number;
        balanceAfterMicro: number;

        requestId:
          | number
          | null;

        platform:
          | string
          | null;

        modelId:
          | string
          | null;

        inputTokens: number;
        outputTokens: number;

        multiplierMilli:
          | number
          | null;

        inputPriceMicroPerMillion:
          | number
          | null;

        outputPriceMicroPerMillion:
          | number
          | null;

        note:
          | string
          | null;

        createdAt: string;
      }>;

    res.json({
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
              row.inputTokens,

            output_tokens:
              row.outputTokens,

            total_tokens:
              row.inputTokens +
              row.outputTokens,

            multiplier:
              row.multiplierMilli ===
              null
                ? null
                : row.multiplierMilli /
                  1000,

            input_price_per_million:
              row.inputPriceMicroPerMillion ===
              null
                ? null
                : microToYuan(
                    row.inputPriceMicroPerMillion,
                  ),

            output_price_per_million:
              row.outputPriceMicroPerMillion ===
              null
                ? null
                : microToYuan(
                    row.outputPriceMicroPerMillion,
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
