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
  releaseWalletReservation,
  reserveWalletBalance,
} from '../services/wallet-reservations.js';

import {
  setWalletReservationId,
  setConsumerIdentity,
} from '../lib/client-context.js';

const consumerRequestTimes = new Map<number, number[]>();

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
  setConsumerIdentity(key.userId, key.id);
  const now = Date.now();
  const recent = (consumerRequestTimes.get(key.id) ?? []).filter((time) => now - time < 60_000);
  const configuredRpm = key.rateLimitRpm ?? Number(getSetting('default_consumer_rpm') ?? 60);
  if (configuredRpm === 0 || recent.length >= configuredRpm) {
    consumerRequestTimes.set(key.id, recent);
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: { message: 'Consumer API key rate limit exceeded.', type: 'rate_limit_exceeded' } });
    return;
  }
  recent.push(now);
  consumerRequestTimes.set(key.id, recent);

  /*
   * Calculate the maximum safe authorization amount
   * before calling any upstream model.
   */
  const estimate =
    estimateBillingReservation(
      db,
      req.body,
    );

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
  if (
    estimate.reserveMicro <= 0
  ) {
    next();
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

      estimate.reserveMicro,
    );

  if (
    reservation.status !==
    'reserved'
  ) {
    res.status(402).json({
      error: {
        message:
          'Insufficient prepaid balance for this request.',

        type:
          'insufficient_balance',

        required_micro:
          estimate.reserveMicro,

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
