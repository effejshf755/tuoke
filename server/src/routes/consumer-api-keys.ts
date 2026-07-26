import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';

import {
  createConsumerApiKey,
  getConsumerApiKeySecret,
  listConsumerApiKeys,
  revokeConsumerApiKey,
  setConsumerApiKeyEnabled,
} from '../services/consumer-api-keys.js';

export const consumerApiKeysRouter =
  Router();

/**
 * 创建 API Key
 *
 * expiration:
 * - never
 * - 7d
 * - 30d
 * - 90d
 * - custom
 *
 * custom 时必须同时传 expiresAt。
 */
const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100),

  expiration: z
    .enum([
      'never',
      '7d',
      '30d',
      '90d',
      'custom',
    ])
    .default('never'),

  expiresAt: z
    .string()
    .trim()
    .optional(),

  key_type: z
    .enum(['universal', 'codex_pool', 'resource_subpool'])
    .default('universal'),
});

/**
 * 暂停 / 恢复 Key
 */
const updateSchema = z.object({
  enabled: z.boolean(),
});

function getUserId(
  req: Parameters<
    typeof consumerApiKeysRouter.get
  >[1] extends never
    ? never
    : any,
): number {
  return (
    req as typeof req & {
      user: {
        userId: number;
      };
    }
  ).user.userId;
}

/**
 * 根据用户选择计算过期时间。
 */
function resolveExpiresAt(
  expiration:
    | 'never'
    | '7d'
    | '30d'
    | '90d'
    | 'custom',

  customExpiresAt?: string,
): string | null {
  if (expiration === 'never') {
    return null;
  }

  const now = Date.now();

  if (expiration === '7d') {
    return new Date(
      now +
        7 *
          24 *
          60 *
          60 *
          1000,
    ).toISOString();
  }

  if (expiration === '30d') {
    return new Date(
      now +
        30 *
          24 *
          60 *
          60 *
          1000,
    ).toISOString();
  }

  if (expiration === '90d') {
    return new Date(
      now +
        90 *
          24 *
          60 *
          60 *
          1000,
    ).toISOString();
  }

  if (!customExpiresAt) {
    throw new Error(
      'Custom expiration date is required',
    );
  }

  const parsed =
    Date.parse(customExpiresAt);

  if (
    !Number.isFinite(parsed) ||
    parsed <= now
  ) {
    throw new Error(
      'Expiration date must be in the future',
    );
  }

  return new Date(
    parsed,
  ).toISOString();
}

/**
 * 获取当前用户全部 API Key
 *
 * GET /api/consumer-keys
 */
consumerApiKeysRouter.get(
  '/',
  (req, res) => {
    const userId =
      getUserId(req);

    const keys =
      listConsumerApiKeys(
        getDb(),
        userId,
      );

    res.json({
      keys,
    });
  },
);

/**
 * 创建 API Key
 *
 * POST /api/consumer-keys
 *
 * 示例：
 *
 * 永久：
 * {
 *   "name": "My App",
 *   "expiration": "never"
 * }
 *
 * 30天：
 * {
 *   "name": "Test Key",
 *   "expiration": "30d"
 * }
 *
 * 自定义：
 * {
 *   "name": "Custom Key",
 *   "expiration": "custom",
 *   "expiresAt": "2027-01-01T00:00:00.000Z"
 * }
 */
consumerApiKeysRouter.post(
  '/',
  (req, res) => {
    const parsed =
      createSchema.safeParse(
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

    let expiresAt:
      | string
      | null;

    try {
      expiresAt =
        resolveExpiresAt(
          parsed.data.expiration,
          parsed.data.expiresAt,
        );
    } catch (error) {
      res.status(400).json({
        error: {
          message:
            (error as Error)
              .message,

          type:
            'validation_error',
        },
      });

      return;
    }

    const userId =
      getUserId(req);

    const created =
      createConsumerApiKey(
        getDb(),
        userId,
        parsed.data.name,
        expiresAt,
        parsed.data.key_type,
      );

    /**
     * 原始 Key 只在创建成功时返回一次。
     */
    res.status(201).json({
      key: created.key,
      ...created.record,
    });
  },
);

/**
 * 暂停 / 恢复 API Key
 *
 * PATCH /api/consumer-keys/:id
 *
 * {
 *   "enabled": false
 * }
 *
 * 或：
 *
 * {
 *   "enabled": true
 * }
 */
consumerApiKeysRouter.patch(
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
            'Invalid API key id',

          type:
            'validation_error',
        },
      });

      return;
    }

    const parsed =
      updateSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            'Invalid enabled value',

          type:
            'validation_error',
        },
      });

      return;
    }

    const userId =
      getUserId(req);

    const success =
      setConsumerApiKeyEnabled(
        getDb(),
        id,
        userId,
        parsed.data.enabled,
      );

    if (!success) {
      res.status(404).json({
        error: {
          message:
            'API key not found or already revoked',

          type:
            'not_found',
        },
      });

      return;
    }

    res.json({
      success: true,
      enabled:
        parsed.data.enabled,
    });
  },
);

/**
 * 永久撤销 API Key
 *
 * DELETE /api/consumer-keys/:id
 *
 * 撤销后不可恢复。
 */
consumerApiKeysRouter.delete(
  '/:id',
  (req, res) => {
    const id =
      Number(req.params.id);

    const userId =
      getUserId(req);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid API key id',

          type:
            'validation_error',
        },
      });

      return;
    }

    const success =
      revokeConsumerApiKey(
        getDb(),
        id,
        userId,
      );

    if (!success) {
      res.status(404).json({
        error: {
          message:
            'Consumer API key not found',

          type:
            'not_found',
        },
      });

      return;
    }

    res.json({
  success: true,
  message: 'API key revoked successfully',
});
  },
);

consumerApiKeysRouter.get(
  '/:id/secret',
  (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: { message: 'Invalid API key id', type: 'validation_error' } });
      return;
    }

    const result = getConsumerApiKeySecret(getDb(), id, getUserId(req));
    if (result.status === 'not_found') {
      res.status(404).json({ error: { message: 'Consumer API key not found', type: 'not_found' } });
      return;
    }
    if (result.status === 'not_recoverable') {
      res.status(409).json({
        error: {
          message: '旧密钥未保存可恢复副本，请撤销后重新创建。',
          type: 'consumer_key_not_recoverable',
        },
      });
      return;
    }

    res.json({ key: result.key });
  },
);
