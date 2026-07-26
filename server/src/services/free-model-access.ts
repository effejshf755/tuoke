import type { Db } from '../db/types.js';

export const FREE_DAILY_LIMIT = 50;
export const RECHARGED_DAILY_LIMIT = 1000;
export const FREE_TIER_RECHARGE_THRESHOLD_MICRO = 10_000_000;
export const PAID_MODEL_MINIMUM_BALANCE_MICRO = 100_000;

export function isExplicitFreeModel(db: Db, requestedModel: string | null): boolean {
  if (!requestedModel || requestedModel === 'auto' || requestedModel.startsWith('auto:')) {
    return false;
  }

  if (requestedModel.toLowerCase().includes(':free')) return true;

  const row = db.prepare(`
    SELECT 1
    FROM models
    WHERE model_id = ?
      AND lower(model_id) LIKE '%:free%'
    LIMIT 1
  `).get(requestedModel);

  return Boolean(row);
}

export function consumeFreeModelRequest(
  db: Db,
  userId: number,
): { allowed: boolean; limit: number; used: number; upgradedUntil: string | null } {
  const user = db.prepare(`
    SELECT free_model_bonus_until AS upgradedUntil
    FROM users
    WHERE id = ?
  `).get(userId) as { upgradedUntil: string | null } | undefined;

  const upgraded = Boolean(
    user?.upgradedUntil
    && Date.parse(`${user.upgradedUntil.replace(' ', 'T')}Z`) > Date.now(),
  );
  const limit = upgraded ? RECHARGED_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const usageDate = db.prepare("SELECT date('now', '+8 hours') AS value").get() as { value: string };

  const updated = db.prepare(`
    INSERT INTO free_model_daily_usage (
      user_id,
      usage_date,
      request_count,
      updated_at
    )
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, usage_date) DO UPDATE SET
      request_count = request_count + 1,
      updated_at = datetime('now')
    WHERE request_count < ?
  `).run(userId, usageDate.value, limit);

  const usage = db.prepare(`
    SELECT request_count AS used
    FROM free_model_daily_usage
    WHERE user_id = ? AND usage_date = ?
  `).get(userId, usageDate.value) as { used: number } | undefined;

  return {
    allowed: updated.changes === 1,
    limit,
    used: usage?.used ?? 0,
    upgradedUntil: user?.upgradedUntil ?? null,
  };
}

export function activateRechargedFreeTier(
  db: Db,
  userId: number,
  amountMicro: number,
): boolean {
  if (amountMicro < FREE_TIER_RECHARGE_THRESHOLD_MICRO) return false;

  const result = db.prepare(`
    UPDATE users
    SET free_model_bonus_until =
      CASE
        WHEN free_model_bonus_until IS NOT NULL
          AND free_model_bonus_until > datetime('now')
        THEN datetime(free_model_bonus_until, '+30 days')
        ELSE datetime('now', '+30 days')
      END
    WHERE id = ?
  `).run(userId);

  return result.changes === 1;
}

export function getAvailableBalanceMicro(db: Db, userId: number): number | null {
  const row = db.prepare(`
    SELECT
      balance_micro - COALESCE(reserved_balance_micro, 0) AS availableMicro
    FROM users
    WHERE id = ?
  `).get(userId) as { availableMicro: number } | undefined;

  return row?.availableMicro ?? null;
}
