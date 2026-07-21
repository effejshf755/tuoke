import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';

export const adminBillingRouter = Router();

const updateBillingSchema = z.object({
  /**
   * 单位：元 / 100万 Token
   *
   * 例如：
   * 2.5 = ¥2.50 / 1M tokens
   */
  input_price_per_million: z
    .number()
    .min(0),

  output_price_per_million: z
    .number()
    .min(0),

  /**
   * 例如：
   * 1   = 1x
   * 1.5 = 1.5x
   * 2   = 2x
   */
  multiplier: z
    .number()
    .min(0),

  billing_enabled: z.boolean(),
});

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

function yuanToMicro(
  yuan: number,
): number {
  return Math.round(
    yuan *
      1_000_000,
  );
}

function milliToMultiplier(
  milli: number,
): number {
  return Number(
    (
      Number(milli || 0) /
      1000
    ).toFixed(3),
  );
}

function multiplierToMilli(
  multiplier: number,
): number {
  return Math.round(
    multiplier *
      1000,
  );
}

/**
 * 获取全部模型及计费规则。
 *
 * GET /api/admin/billing/models
 *
 * 可选：
 * ?q=deepseek
 */
adminBillingRouter.get(
  '/models',
  (req, res) => {
    const db = getDb();

    const search =
      typeof req.query.q ===
      'string'
        ? req.query.q
            .trim()
            .toLowerCase()
        : '';

    const searchLike =
      `%${search}%`;

    const rows =
      db.prepare(`
        SELECT
          m.id,

          m.platform,

          m.model_id
            AS modelId,

          m.display_name
            AS displayName,

          m.enabled
            AS modelEnabled,

          CASE
            WHEN b.id IS NULL
            THEN 0
            ELSE 1
          END
            AS billingConfigured,

          COALESCE(
            b.input_price_micro_per_million,
            0
          )
            AS inputPriceMicroPerMillion,

          COALESCE(
            b.output_price_micro_per_million,
            0
          )
            AS outputPriceMicroPerMillion,

          COALESCE(
            b.multiplier_milli,
            1000
          )
            AS multiplierMilli,

          COALESCE(
            b.billing_enabled,
            0
          )
            AS billingEnabled,

          (
            SELECT COUNT(*)

            FROM requests r

            WHERE
              r.platform =
                m.platform

              AND
              r.model_id =
                m.model_id
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
                r.platform =
                  m.platform

                AND
                r.model_id =
                  m.model_id
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
                r.platform =
                  m.platform

                AND
                r.model_id =
                  m.model_id
            ),
            0
          )
            AS outputTokens,

          COALESCE(
            (
              SELECT SUM(
                COALESCE(
                  r.billing_amount_micro,
                  0
                )
              )

              FROM requests r

              WHERE
                r.platform =
                  m.platform

                AND
                r.model_id =
                  m.model_id
            ),
            0
          )
            AS revenueMicro

        FROM models m

        LEFT JOIN
          model_billing_rules b

          ON
            b.platform =
              m.platform

            AND
            b.model_id =
              m.model_id

        WHERE
          ? = ''

          OR
          LOWER(
            m.display_name
          ) LIKE ?

          OR
          LOWER(
            m.model_id
          ) LIKE ?

          OR
          LOWER(
            m.platform
          ) LIKE ?

        ORDER BY
          m.platform ASC,
          m.display_name ASC,
          m.id ASC
      `)
        .all(
          search,
          searchLike,
          searchLike,
          searchLike,
        ) as Array<{
          id: number;
          platform: string;
          modelId: string;
          displayName: string;
          modelEnabled: number;
          billingConfigured: number;
          inputPriceMicroPerMillion: number;
          outputPriceMicroPerMillion: number;
          multiplierMilli: number;
          billingEnabled: number;
          requestCount: number;
          inputTokens: number;
          outputTokens: number;
          revenueMicro: number;
        }>;

    res.json({
      models:
        rows.map(
          (row) => ({
            id: row.id,

            platform:
              row.platform,

            model_id:
              row.modelId,

            display_name:
              row.displayName,

            model_enabled:
              Boolean(
                row.modelEnabled,
              ),

            billing_configured:
              Boolean(
                row.billingConfigured,
              ),

            input_price_per_million:
              microToYuan(
                row.inputPriceMicroPerMillion,
              ),

            output_price_per_million:
              microToYuan(
                row.outputPriceMicroPerMillion,
              ),

            multiplier:
              milliToMultiplier(
                row.multiplierMilli,
              ),

            billing_enabled:
              Boolean(
                row.billingEnabled,
              ),

            request_count:
              Number(
                row.requestCount || 0,
              ),

            input_tokens:
              Number(
                row.inputTokens || 0,
              ),

            output_tokens:
              Number(
                row.outputTokens || 0,
              ),

            revenue:
              microToYuan(
                row.revenueMicro,
              ),
          }),
        ),
    });
  },
);

/**
 * 设置某个模型的计费规则。
 *
 * PUT /api/admin/billing/models/:id
 *
 * Body:
 *
 * {
 *   "input_price_per_million": 2,
 *   "output_price_per_million": 8,
 *   "multiplier": 1.5,
 *   "billing_enabled": true
 * }
 */
adminBillingRouter.put(
  '/models/:id',
  (req, res) => {
    const id =
      Number(
        req.params.id,
      );

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid model id',

          type:
            'validation_error',
        },
      });

      return;
    }

    const parsed =
      updateBillingSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            'Invalid billing configuration',

          type:
            'validation_error',
        },
      });

      return;
    }

    const db = getDb();

    const model =
      db.prepare(`
        SELECT
          id,
          platform,
          model_id AS modelId,
          display_name
            AS displayName
        FROM models
        WHERE id = ?
      `)
        .get(id) as
        | {
            id: number;
            platform: string;
            modelId: string;
            displayName: string;
          }
        | undefined;

    if (!model) {
      res.status(404).json({
        error: {
          message:
            'Model not found',

          type:
            'not_found',
        },
      });

      return;
    }

    const inputPriceMicro =
      yuanToMicro(
        parsed.data
          .input_price_per_million,
      );

    const outputPriceMicro =
      yuanToMicro(
        parsed.data
          .output_price_per_million,
      );

    const multiplierMilli =
      multiplierToMilli(
        parsed.data.multiplier,
      );

    db.prepare(`
      INSERT INTO
        model_billing_rules
        (
          platform,
          model_id,
          input_price_micro_per_million,
          output_price_micro_per_million,
          multiplier_milli,
          billing_enabled
        )

      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )

      ON CONFLICT(
        platform,
        model_id
      )

      DO UPDATE SET
        input_price_micro_per_million =
          excluded.input_price_micro_per_million,

        output_price_micro_per_million =
          excluded.output_price_micro_per_million,

        multiplier_milli =
          excluded.multiplier_milli,

        billing_enabled =
          excluded.billing_enabled,

        updated_at =
          datetime('now')
    `)
      .run(
        model.platform,
        model.modelId,
        inputPriceMicro,
        outputPriceMicro,
        multiplierMilli,
        parsed.data
          .billing_enabled
          ? 1
          : 0,
      );

    res.json({
      success: true,

      model: {
        id:
          model.id,

        platform:
          model.platform,

        model_id:
          model.modelId,

        display_name:
          model.displayName,

        input_price_per_million:
          parsed.data
            .input_price_per_million,

        output_price_per_million:
          parsed.data
            .output_price_per_million,

        multiplier:
          parsed.data
            .multiplier,

        billing_enabled:
          parsed.data
            .billing_enabled,
      },
    });
  },
);