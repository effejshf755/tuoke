import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  clientContextMiddleware,
  setConsumerIdentity,
  setResourceReservation,
} from '../../lib/client-context.js';
import { logRequest } from '../../lib/request-log.js';
import { createConsumerApiKey } from '../../services/consumer-api-keys.js';
import { reserveSubpoolQuota } from '../../services/resource-quota.js';

function entitlement(sequence: number) {
  const db = getDb();
  const userId = Number(db.prepare(`INSERT INTO users (email, password_hash, balance_micro)
    VALUES (?, 'x', 100000000)`).run(`stream-${sequence}@example.com`).lastInsertRowid);
  const key = createConsumerApiKey(db, userId, `Stream ${sequence}`, null, 'resource_subpool');
  const subpoolId = Number(db.prepare(`INSERT INTO resource_subpools
    (name, mode, status, member_limit, starts_at, ends_at)
    VALUES (?, 'dedicated', 'active', 1, datetime('now'), datetime('now', '+1 month'))`)
    .run(`stream-${sequence}`).lastInsertRowid);
  const memberId = Number(db.prepare(`INSERT INTO resource_subpool_members
    (subpool_id, user_id, consumer_api_key_id, status, activated_at)
    VALUES (?, ?, ?, 'active', datetime('now'))`).run(subpoolId, userId, key.record.id).lastInsertRowid);
  const periodId = Number(db.prepare(`INSERT INTO resource_subpool_quota_periods
    (subpool_id, period_key, allocation_units, starts_at, resets_at)
    VALUES (?, ?, 1000, datetime('now'), datetime('now', '+1 month'))`)
    .run(subpoolId, `stream-${sequence}`).lastInsertRowid);
  const quotaId = Number(db.prepare(`INSERT INTO resource_member_quotas
    (subpool_period_id, member_id, allocation_units) VALUES (?, ?, 1000)`)
    .run(periodId, memberId).lastInsertRowid);
  return { userId, keyId: key.record.id, subpoolId, memberId, quotaId };
}

function withinResourceRequest(seed: ReturnType<typeof entitlement>, callback: () => void) {
  const db = getDb();
  const reservation = reserveSubpoolQuota(db, seed.userId, seed.keyId, 100);
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any;
  clientContextMiddleware(req, {} as any, () => {
    setConsumerIdentity(seed.userId, seed.keyId, 'resource_subpool');
    setResourceReservation(reservation);
    callback();
  });
  return reservation;
}

describe('resource stream interruption settlement', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '7'.repeat(64);
    initDb(':memory:');
  });

  it('settles partial quota when a disconnected stream already produced tokens', () => {
    const seed = entitlement(1);
    const reservation = withinResourceRequest(seed, () => {
      logRequest('openai-codex', 'gpt-stream', -1, 'error', 20, 7, 25, 'client disconnected after stream usage');
    });
    expect(getDb().prepare(`SELECT used_units used, reserved_units reserved
      FROM resource_member_quotas WHERE id = ?`).get(seed.quotaId)).toEqual({ used: 1, reserved: 0 });
    expect(getDb().prepare(`SELECT status, settlement_status settlementStatus, actual_units actual
      FROM resource_quota_reservations WHERE id = ?`).get(reservation.reservationId))
      .toEqual({ status: 'settled', settlementStatus: 'partial', actual: 1 });
    expect((getDb().prepare('SELECT balance_micro balance FROM users WHERE id = ?').get(seed.userId) as any).balance)
      .toBe(100000000);
  });

  it('releases the reservation when dispatch fails before any upstream usage', () => {
    const seed = entitlement(2);
    const reservation = withinResourceRequest(seed, () => {
      logRequest('openai-codex', 'gpt-stream', -1, 'error', 20, 0, 10, 'upstream connection failed');
    });
    expect(getDb().prepare(`SELECT used_units used, reserved_units reserved
      FROM resource_member_quotas WHERE id = ?`).get(seed.quotaId)).toEqual({ used: 0, reserved: 0 });
    expect(getDb().prepare(`SELECT status, settlement_status settlementStatus, actual_units actual
      FROM resource_quota_reservations WHERE id = ?`).get(reservation.reservationId))
      .toEqual({ status: 'failed', settlementStatus: 'failed_before_usage', actual: 0 });
  });
});
