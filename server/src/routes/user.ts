import crypto from 'crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import {
  hashPassword,
  verifyPassword,
} from '../lib/password.js';
import { consumerQuota } from '../middleware/consumerQuota.js';
import { chatCompletionHandler } from './proxy.js';
import { getModelHealthMap } from '../services/model-health.js';


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

userRouter.get('/codex-models', (_req, res) => {
  const rows = getDb().prepare(`
    SELECT am.model_id,
      MIN(b.input_price_micro_per_million) input_price,
      MIN(b.output_price_micro_per_million) output_price,
      MIN(b.multiplier_milli) multiplier
    FROM codex_oauth_account_models am
    JOIN codex_oauth_accounts a ON a.id = am.account_id
    JOIN model_billing_rules b
      ON b.platform = 'openai-codex'
     AND b.model_id = am.model_id
     AND b.billing_enabled = 1
    WHERE am.enabled = 1
      AND a.resource_scope = 'codex_pool'
    GROUP BY am.model_id
    ORDER BY CASE am.model_id
      WHEN 'gpt-5.6-sol' THEN 1
      WHEN 'gpt-5.6-terra' THEN 2
      WHEN 'gpt-5.6-luna' THEN 3
      WHEN 'gpt-5.5' THEN 4
      WHEN 'gpt-5.4-mini' THEN 5
      WHEN 'gpt-5.4' THEN 6
      ELSE 999
    END, am.model_id ASC
  `).all() as Array<{
    model_id: string;
    input_price: number;
    output_price: number;
    multiplier: number;
  }>;
  res.json({ models: rows.map(row => ({
    model_id: row.model_id,
    input_price_per_million: Number((row.input_price / 1_000_000).toFixed(6)),
    output_price_per_million: Number((row.output_price / 1_000_000).toFixed(6)),
    multiplier: Number((row.multiplier / 1_000).toFixed(3)),
  })) });
});

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
         OR (
           consumer_user_id IS NULL
           AND consumer_api_key_id IN (
             SELECT id FROM consumer_api_keys WHERE user_id = ?
           )
         )
    `)
    .get(userId, userId) as {
      total_requests: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };

  res.json({
    ...row,
  });
});

/**
 * GET /api/user/requests?page=1&limit=50&model=...&status=...&api_key_id=...
 * Current user's consumer API request history. Sensitive request headers and
 * key material are deliberately not selected.
 */
userRouter.get('/requests', (req, res) => {
  const userId = getUserId(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const apiKeyId = typeof req.query.api_key_id === 'string' ? Number(req.query.api_key_id) : null;
  const db = getDb();
  const ownership = `(
    r.consumer_user_id = ?
    OR (r.consumer_user_id IS NULL AND k.user_id = ?)
  )`;
  const filters = `
    ${ownership}
    AND (? = '' OR r.requested_model LIKE '%' || ? || '%' OR r.model_id LIKE '%' || ? || '%')
    AND (? = '' OR r.status = ?)
    AND (? IS NULL OR r.consumer_api_key_id = ?)
  `;
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM requests r
    LEFT JOIN consumer_api_keys k ON k.id = r.consumer_api_key_id
    WHERE ${filters}
  `).get(userId, userId, model, model, model, status, status, apiKeyId, apiKeyId) as { total: number };
  const rows = db.prepare(`
    SELECT r.id, r.created_at AS createdAt, r.consumer_api_key_id AS consumerApiKeyId,
      COALESCE(k.name, k.key_prefix, '未知 Key') AS apiKeyName,
      r.requested_model AS requestedModel, r.model_id AS routedModel, r.platform,
      r.status, r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
      (r.input_tokens + r.output_tokens) AS totalTokens,
      r.billing_amount_micro AS billingAmountMicro, r.billing_status AS billingStatus,
      r.latency_ms AS latencyMs, r.error
    FROM requests r
    LEFT JOIN consumer_api_keys k ON k.id = r.consumer_api_key_id
    WHERE ${filters}
    ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(userId, userId, model, model, model, status, status, apiKeyId, apiKeyId, limit, offset) as Array<Record<string, unknown>>;
  res.json({
    requests: rows.map((row) => ({
      ...row,
      error: typeof row.error === 'string' ? row.error.slice(0, 300) : null,
    })),
    pagination: { page, limit, total: Number(totalRow.total), pages: Math.ceil(Number(totalRow.total) / limit) },
  });
});

/**
 * 当前可用模型
 */
userRouter.get('/models', (_req, res) => {
  const db = getDb();
  const health = getModelHealthMap(db);
  const rows = db
    .prepare(`
      SELECT
        models.model_id,
        models.display_name,
        models.platform,
        models.context_window,
        models.enabled,
        models.paid_input_per_m,
        models.paid_output_per_m,
        mbr.input_price_micro_per_million,
        mbr.output_price_micro_per_million,
        mbr.multiplier_milli,
        mbr.billing_enabled
      FROM models
      INNER JOIN model_billing_rules mbr
        ON mbr.platform = models.platform
       AND mbr.model_id = models.model_id
       AND mbr.billing_enabled = 1
      WHERE models.enabled = 1
        AND EXISTS (
          SELECT 1
          FROM api_keys k
          WHERE k.platform = models.platform
            AND k.enabled = 1
            AND (models.key_id IS NULL OR k.id = models.key_id)
        )
      ORDER BY
  models.intelligence_rank ASC,
  models.model_id ASC
    `)
    .all()
    .filter((row: any) => health[`${row.platform}:${row.model_id}`]?.status !== 'failed');

  res.json({
    models: [
      ...(rows.length > 0 ? [{
        model_id: 'auto',
        display_name: 'Auto',
        platform: 'Tuoke API',
        context_window: null,
        enabled: 1,
        billing_configured: true,
        billing_enabled: true,
        input_price: null,
        output_price: null,
        multiplier: 1,
      }] : []),

      ...rows.map((row: any) => {
        const configured = row.input_price_micro_per_million != null;
        const multiplier = Number(row.multiplier_milli ?? 1000) / 1000;
        return {
          model_id: row.model_id,
          display_name: row.display_name,
          platform: row.platform,
          context_window: row.context_window,
          enabled: row.enabled,
          billing_configured: configured,
          billing_enabled: configured && row.billing_enabled !== 0,
          input_price: configured ? Number(row.input_price_micro_per_million) / 1_000_000 * multiplier : null,
          output_price: configured ? Number(row.output_price_micro_per_million) / 1_000_000 * multiplier : null,
          multiplier,
        };
      }),
    ],
  });
});

/** Dashboard Playground: uses the current user's consumer quota and billing path. */
userRouter.post('/playground/chat', consumerQuota, chatCompletionHandler);
userRouter.post(
  '/playground/chat/stream',
  consumerQuota,
  (req, res) => {
    req.body.stream = true;
    return chatCompletionHandler(req, res);
  },
);
/**
 * Playground 聊天记录
 */

userRouter.get('/playground/conversations', (req, res) => {
  const userId = getUserId(req);

  const rows = getDb()
    .prepare(`
      SELECT
        id,
        title,
        model_id AS modelId,
        system_prompt AS systemPrompt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM playground_conversations
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 100
    `)
    .all(userId);

  res.json({
    conversations: rows,
  });
});

userRouter.post('/playground/conversations', (req, res) => {
  const userId = getUserId(req);

  const modelId =
    typeof req.body?.model === 'string'
      ? req.body.model.trim()
      : '';

  const systemPrompt =
    typeof req.body?.systemPrompt === 'string'
      ? req.body.systemPrompt
      : '';

  if (!modelId) {
    res.status(400).json({
      error: {
        message: 'Model is required',
        type: 'validation_error',
      },
    });

    return;
  }

  const result = getDb()
    .prepare(`
      INSERT INTO playground_conversations (
        user_id,
        title,
        model_id,
        system_prompt
      )
      VALUES (?, ?, ?, ?)
    `)
    .run(
      userId,
      '新对话',
      modelId,
      systemPrompt,
    );

  res.json({
    id: Number(result.lastInsertRowid),
  });
});

userRouter.delete('/playground/conversations', (req, res) => {
  const userId = getUserId(req);
  const result = getDb()
    .prepare('DELETE FROM playground_conversations WHERE user_id = ?')
    .run(userId);

  res.json({
    success: true,
    deleted: result.changes,
  });
});

userRouter.get(
  '/playground/conversations/:id/messages',
  (req, res) => {
    const userId = getUserId(req);
    const conversationId = Number(req.params.id);

    const conversation = getDb()
      .prepare(`
        SELECT id
        FROM playground_conversations
        WHERE id = ?
          AND user_id = ?
      `)
      .get(conversationId, userId);

    if (!conversation) {
      res.status(404).json({
        error: {
          message: 'Conversation not found',
          type: 'not_found',
        },
      });

      return;
    }

    const messages = getDb()
      .prepare(`
        SELECT
          id,
          role,
          content,
          prompt_tokens AS promptTokens,
          completion_tokens AS completionTokens,
          total_tokens AS totalTokens,
          cost_micro AS costMicro,
          created_at AS createdAt
        FROM playground_messages
        WHERE conversation_id = ?
        ORDER BY id ASC
      `)
      .all(conversationId);

    res.json({
      messages,
    });
  },
);

userRouter.post(
  '/playground/conversations/:id/messages',
  (req, res) => {
    const userId = getUserId(req);
    const conversationId = Number(req.params.id);

    const role =
      req.body?.role === 'assistant'
        ? 'assistant'
        : req.body?.role === 'user'
          ? 'user'
          : '';

    const content =
      typeof req.body?.content === 'string'
        ? req.body.content
        : '';

    if (!role || !content.trim()) {
      res.status(400).json({
        error: {
          message: 'Invalid message',
          type: 'validation_error',
        },
      });

      return;
    }

    const db = getDb();

    const conversation = db
      .prepare(`
        SELECT id
        FROM playground_conversations
        WHERE id = ?
          AND user_id = ?
      `)
      .get(conversationId, userId);

    if (!conversation) {
      res.status(404).json({
        error: {
          message: 'Conversation not found',
          type: 'not_found',
        },
      });

      return;
    }

    const transaction = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO playground_messages (
            conversation_id,
            role,
            content
          )
          VALUES (?, ?, ?)
        `)
        .run(
          conversationId,
          role,
          content,
        );

      if (role === 'user') {
        const title =
          content.trim().slice(0, 40) || '新对话';

        db.prepare(`
          UPDATE playground_conversations
          SET
            title = CASE
              WHEN title = '新对话'
              THEN ?
              ELSE title
            END,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          title,
          conversationId,
        );
      } else {
        db.prepare(`
          UPDATE playground_conversations
          SET updated_at = datetime('now')
          WHERE id = ?
        `).run(conversationId);
      }

      return Number(result.lastInsertRowid);
    });

    const id = transaction();

    res.json({
      id,
      success: true,
    });
  },
);

userRouter.delete(
  '/playground/conversations/:id',
  (req, res) => {
    const userId = getUserId(req);
    const conversationId = Number(req.params.id);

    const result = getDb()
      .prepare(`
        DELETE FROM playground_conversations
        WHERE id = ?
          AND user_id = ?
      `)
      .run(conversationId, userId);

    res.json({
      success: result.changes > 0,
    });
  },
);
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
