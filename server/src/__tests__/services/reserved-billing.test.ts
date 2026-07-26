import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { chargeReservedRequest } from '../../services/reserved-billing.js';
import { reserveWalletBalance } from '../../services/wallet-reservations.js';

describe('reserved PAYG billing', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
  });

  it('charges only the spendable wallet balance when actual usage costs more', () => {
    const db = getDb();
    const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
      VALUES ('capped-settlement@example.com', 'x', 100000)`).run().lastInsertRowid);
    const model = db.prepare(`SELECT platform, model_id modelId FROM model_billing_rules
      WHERE billing_enabled = 1 LIMIT 1`).get() as { platform: string; modelId: string };
    db.prepare(`UPDATE model_billing_rules SET input_price_micro_per_million = 1000000000,
      output_price_micro_per_million = 1000000000, multiplier_milli = 1000
      WHERE platform = ? AND model_id = ?`).run(model.platform, model.modelId);

    const reserved = reserveWalletBalance(db, userId, null, model.modelId, 100_000);
    expect(reserved.status).toBe('reserved');
    if (reserved.status !== 'reserved') throw new Error('Expected reservation');

    const requestId = Number(db.prepare(`INSERT INTO requests
      (platform, model_id, status, input_tokens, output_tokens, consumer_user_id, billing_status)
      VALUES (?, ?, 'success', 1000, 1000, ?, 'unbilled')`)
      .run(model.platform, model.modelId, userId).lastInsertRowid);
    const result = chargeReservedRequest(db, requestId, reserved.reservationId);

    expect(result).toEqual({ status: 'charged', amountMicro: 100_000, balanceAfterMicro: 0 });
    expect(db.prepare(`SELECT balance_micro balanceMicro, reserved_balance_micro reservedMicro
      FROM users WHERE id = ?`).get(userId)).toEqual({ balanceMicro: 0, reservedMicro: 0 });
    expect(db.prepare(`SELECT billing_amount_micro amountMicro, billing_status status
      FROM requests WHERE id = ?`).get(requestId)).toEqual({ amountMicro: 100_000, status: 'charged' });
    expect(db.prepare(`SELECT actual_micro actualMicro, status FROM wallet_reservations
      WHERE id = ?`).get(reserved.reservationId)).toEqual({ actualMicro: 100_000, status: 'settled' });
  });
});
