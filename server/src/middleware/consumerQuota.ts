import type {
  NextFunction,
  Request,
  Response,
} from 'express';

import {
  getDb,
} from '../db/index.js';
import { getSetting } from '../db/index.js';

import {
  validateConsumerApiKey,
  listConsumerApiKeys,
} from '../services/consumer-api-keys.js';

import {
  estimateBillingReservation,
} from '../services/billing-reservation.js';

import {
  estimateCodexBillingReservation,
} from '../services/codex-billing.js';

import {
  releaseWalletReservation,
  reserveWalletBalance,
} from '../services/wallet-reservations.js';

import {
  setWalletReservationId,
  setConsumerIdentity,
  setResourceReservation,
  getClientContext,
  setFreeModelUsage,
} from '../lib/client-context.js';
import {
  estimateCodexQuotaUnits,
  releaseSubpoolQuota,
  reserveSubpoolQuota,
  ResourceQuotaError,
} from '../services/resource-quota.js';
import {
  consumeFreeModelRequest,
  releaseFreeModelRequest,
  getAvailableBalanceMicro,
  isExplicitFreeModel,
  PAID_MODEL_MINIMUM_BALANCE_MICRO,
} from '../services/free-model-access.js';

const consumerRequestTimes = new Map<number, number[]>();
const consumerUserRequestTimes = new Map<number, number[]>();

/**
 * Prepaid consumer billing gate.
 *
 * Only tuoke-* consumer API keys are affected.
 *
 * Global/admin unified API keys bypass wallet billing.
 */
export function consumerQuota(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  /*
   * Read-only endpoints do not create model cost.
   */
  if (
    req.method === 'GET' ||
    req.method === 'HEAD'
  ) {
    next();
    return;
  }

  const bearer =
    req.headers.authorization
      ?.replace(
        /^Bearer\s+/i,
        '',
      )
      .trim();

  const apiKeyHeader =
    req.headers[
      'x-api-key'
    ];

  const token =
    bearer ||
    (
      Array.isArray(
        apiKeyHeader,
      )
        ? apiKeyHeader[0]
        : apiKeyHeader
    )?.trim();

  /*
   * Admin/global unified key:
   * no consumer wallet billing.
   */
  const dashboardUser = (req as Request & { user?: { userId?: number } }).user?.userId;
  const isDashboardPlayground = Boolean(dashboardUser && req.path === '/playground/chat');
  if (!token?.startsWith('tuoke-') && !isDashboardPlayground) {
    next();
    return;
  }

  const db =
    getDb();

  const key = token?.startsWith('tuoke-')
    ? validateConsumerApiKey(db, token)
    : listConsumerApiKeys(db, dashboardUser!).find((candidate) =>
        candidate.status === 'active'
        && candidate.enabled === 1
        && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())) ?? null;

  if (!key && isDashboardPlayground) {
    res.status(400).json({ error: { message: '请先创建一个可用的 Consumer API Key。', type: 'playground_key_required' } });
    return;
  }

  /*
   * Authentication middleware will return the
   * canonical invalid-key response later.
   */
  if (!key) {
    next();
    return;
  }

  // Establish identity before any downstream route can log the request.
  // Global/admin keys never enter this branch because they do not use the
  // tuoke-* consumer-key namespace.
  setConsumerIdentity(key.userId, key.id, key.keyType);

  const requestedModel = typeof req.body?.model === 'string'
    ? req.body.model.trim()
    : '';
  const explicitCodexAlias = requestedModel === 'codex'
    || requestedModel === 'openai-codex/codex';
  const knownCodexModel = requestedModel !== '' && (
    explicitCodexAlias
    || Boolean(db.prepare(`
      SELECT 1
      FROM models
      WHERE platform = 'openai-codex'
        AND model_id = ?
      LIMIT 1
    `).get(requestedModel))
    || Boolean(db.prepare(`
      SELECT 1
      FROM codex_oauth_account_models
      WHERE model_id = ?
      LIMIT 1
    `).get(requestedModel))
  );
  const knownOrdinaryModel = requestedModel !== '' && Boolean(db.prepare(`
    SELECT 1
    FROM models m
    JOIN model_billing_rules b
      ON b.platform = m.platform
     AND b.model_id = m.model_id
     AND b.billing_enabled = 1
    WHERE m.platform <> 'openai-codex'
      AND m.model_id = ?
      AND m.enabled = 1
    LIMIT 1
  `).get(requestedModel));

  if (
    key.keyType === 'universal'
    && (explicitCodexAlias || (knownCodexModel && !knownOrdinaryModel))
  ) {
    res.status(403).json({
      error: {
        message: 'This API key does not have access to Codex pool',
        type: 'permission_error',
      },
    });
    return;
  }

  if (
    key.keyType !== 'universal'
    && !knownCodexModel
  ) {
    res.status(403).json({
      error: {
        message: 'This API key only has access to Codex pool',
        type: 'permission_error',
      },
    });
    return;
  }
  const now = Date.now();
  const recent = (consumerRequestTimes.get(key.id) ?? []).filter((time) => now - time < 60_000);
  const configuredRpm = key.rateLimitRpm ?? Number(getSetting('default_consumer_rpm') ?? 60);
  if (configuredRpm === 0 || recent.length >= configuredRpm) {
    consumerRequestTimes.set(key.id, recent);
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: { message: 'Consumer API key rate limit exceeded.', type: 'rate_limit_exceeded' } });
    return;
  }
  const userRecent = (consumerUserRequestTimes.get(key.userId) ?? []).filter((time) => now - time < 60_000);
  const userRpm = Number(getSetting('default_consumer_rpm') ?? 60);
  if (userRpm === 0 || userRecent.length >= userRpm) {
    consumerRequestTimes.set(key.id, recent);
    consumerUserRequestTimes.set(key.userId, userRecent);
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: { message: 'Consumer user rate limit exceeded.', type: 'rate_limit_exceeded' } });
    return;
  }
  recent.push(now);
  consumerRequestTimes.set(key.id, recent);
  userRecent.push(now);
  consumerUserRequestTimes.set(key.userId, userRecent);

  /*
   * Calculate the maximum safe authorization amount
   * before calling any upstream model.
   */
  const estimate = key.keyType !== 'universal'
    ? estimateCodexBillingReservation(db, req.body)
    : estimateBillingReservation(db, req.body);

  /*
   * Consumer requests must never silently use an
   * unpriced model.
   */
  if (
    estimate.status ===
    'no_billing_rule'
  ) {
    res.status(503).json({
      error: {
        message:
          'This model is not currently available for billed API usage.',

        type:
          'billing_not_configured',

        model:
          estimate.requestedModel,
      },
    });

    return;
  }

  /*
   * Explicitly configured free model:
   *
   * No wallet reservation is needed.
   * logRequest() will later mark it as free.
   */
  const explicitFreeModel =
    key.keyType === 'universal'
    && isExplicitFreeModel(db, estimate.requestedModel);

  if (explicitFreeModel) {
    const freeAccess = consumeFreeModelRequest(db, key.userId);
    res.setHeader('X-Free-Model-Daily-Limit', String(freeAccess.limit));
    res.setHeader('X-Free-Model-Daily-Used', String(freeAccess.used));

    if (!freeAccess.allowed) {
      res.status(429).json({
        error: {
          message: freeAccess.limit === 50
            ? 'Daily free-model limit reached. Recharge at least 10 yuan to unlock 1000 requests per day for 30 days.'
            : 'Daily free-model limit reached.',
          type: 'free_model_daily_limit_exceeded',
          limit: freeAccess.limit,
          used: freeAccess.used,
          upgraded_until: freeAccess.upgradedUntil,
        },
      });
      return;
    }

    const usageDate = (db.prepare("SELECT date('now', '+8 hours') AS value").get() as { value: string }).value;
    setFreeModelUsage(usageDate);
    const context = getClientContext();
    let scheduled = false;
    const cleanup = () => {
      if (scheduled) return;
      scheduled = true;
      const timer = setTimeout(() => {
        if (!context.freeModelUsageCommitted) releaseFreeModelRequest(db, key.userId, usageDate);
      }, 5000);
      timer.unref();
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);

    next();
    return;
  }

  if (key.keyType === 'resource_subpool') {
    let resourceReservation: ReturnType<typeof reserveSubpoolQuota>;
    try {
      resourceReservation = reserveSubpoolQuota(db, key.userId, key.id, estimateCodexQuotaUnits(db, req.body));
      setResourceReservation(resourceReservation);
    } catch (error) {
      if (error instanceof ResourceQuotaError) {
        res.status(error.code === 'resource_quota_exhausted' ? 429 : 403).json({ error: { message: error.message, type: error.code } });
        return;
      }
      throw error;
    }
    // Resource products are prepaid entitlements. Once their isolated quota
    // reservation succeeds, the request must not enter PAYG wallet billing.
    registerResourceCleanup(res, db, resourceReservation.reservationId);
    next();
    return;
  }

  if (estimate.reserveMicro <= 0) {
    next();
    return;
  }

  const availableMicro = getAvailableBalanceMicro(db, key.userId);
  if (availableMicro === null || availableMicro < PAID_MODEL_MINIMUM_BALANCE_MICRO) {
    res.status(402).json({
      error: {
        message: 'Paid models require an available balance of at least 0.1 yuan.',
        type: 'minimum_balance_required',
        minimum_balance_micro: PAID_MODEL_MINIMUM_BALANCE_MICRO,
        available_micro: availableMicro ?? 0,
      },
    });
    return;
  }

  /*
   * Atomically reserve prepaid balance.
   *
   * This prevents concurrent requests from spending
   * the same balance twice.
   */
  const reservation =
    reserveWalletBalance(
      db,

      key.userId,

      null,

      estimate.requestedModel,

      Math.max(PAID_MODEL_MINIMUM_BALANCE_MICRO, estimate.reserveMicro),
    );

  if (
    reservation.status !==
    'reserved'
  ) {
    res.status(402).json({
      error: {
        message:
          'Paid models require an available balance of at least 0.1 yuan.',

        type:
          'insufficient_balance',

        required_micro:
          Math.max(PAID_MODEL_MINIMUM_BALANCE_MICRO, estimate.reserveMicro),

        available_micro:
          reservation.availableMicro,
      },
    });

    return;
  }

  const reservationId =
    reservation.reservationId;

  /*
   * Make the reservation visible to logRequest()
   * throughout this exact async request.
   */
  setWalletReservationId(
    reservationId,
  );

  /*
   * Safety cleanup.
   *
   * Successful requests normally settle the
   * reservation inside logRequest().
   *
   * If the entire request fails, authentication
   * rejects it later, the client disconnects, or all
   * provider routes fail, the reservation is released.
   *
   * Delay slightly so streaming handlers that call
   * logRequest immediately after res.end() get time
   * to perform settlement first.
   */
  let cleanupScheduled =
    false;

  const scheduleCleanup =
    () => {
      if (
        cleanupScheduled
      ) {
        return;
      }

      cleanupScheduled =
        true;

      const timer =
        setTimeout(
          () => {
            try {
              releaseWalletReservation(
                db,
                reservationId,
                'failed',
              );
            } catch (
              error
            ) {
              console.error(
                '[Billing] Failed to release unfinished reservation:',
                reservationId,
                error,
              );
            }
          },

          5000,
        );

      timer.unref();
    };

  res.once(
    'finish',
    scheduleCleanup,
  );

  res.once(
    'close',
    scheduleCleanup,
  );

  next();
}

function registerResourceCleanup(res: Response, db: ReturnType<typeof getDb>, reservationId: number | null): void {
  if (reservationId === null) return;
  const requestContext = getClientContext();
  let scheduled = false;
  const cleanup = () => {
    if (scheduled) return;
    scheduled = true;
    const timer = setTimeout(() => {
      try {
        // A disconnected stream may still be unwinding the Provider generator
        // and writing its partial usage record. Never release known usage from
        // this transport-level safety hook; request-log owns its settlement.
        if (!requestContext.resourceUsageObserved) releaseSubpoolQuota(db, reservationId);
      }
      catch (error) { console.error('[Resource Quota] Failed to release unfinished reservation:', reservationId, error); }
    }, 5000);
    timer.unref();
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
}
