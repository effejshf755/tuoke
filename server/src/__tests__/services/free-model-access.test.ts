import BetterSqlite from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { up as migrateFreeModelAccess } from '../../db/migrations/20260723_000029_free_model_access.js';
import {
  activateRechargedFreeTier,
  consumeFreeModelRequest,
  FREE_DAILY_LIMIT,
  getAvailableBalanceMicro,
  isExplicitFreeModel,
  PAID_MODEL_MINIMUM_BALANCE_MICRO,
  RECHARGED_DAILY_LIMIT,
} from '../../services/free-model-access.js';

function createDb() {
  const db = new BetterSqlite(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      balance_micro INTEGER NOT NULL DEFAULT 0,
      reserved_balance_micro INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE models (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL
    );
    INSERT INTO users (id, balance_micro, reserved_balance_micro)
    VALUES (1, 2000000, 250000);
  `);
  migrateFreeModelAccess(db);
  return db;
}

describe('free model access policy', () => {
  it('recognizes only explicit :free models', () => {
    const db = createDb();
    db.prepare("INSERT INTO models (platform, model_id) VALUES ('openrouter', 'vendor/model:free')").run();
    expect(isExplicitFreeModel(db, 'vendor/model:free')).toBe(true);
    expect(isExplicitFreeModel(db, 'vendor/paid-model')).toBe(false);
    expect(isExplicitFreeModel(db, 'auto')).toBe(false);
  });

  it('limits a regular user to 50 free-model requests per Beijing day', () => {
    const db = createDb();
    for (let index = 0; index < FREE_DAILY_LIMIT; index += 1) {
      expect(consumeFreeModelRequest(db, 1).allowed).toBe(true);
    }
    const rejected = consumeFreeModelRequest(db, 1);
    expect(rejected.allowed).toBe(false);
    expect(rejected.limit).toBe(FREE_DAILY_LIMIT);
    expect(rejected.used).toBe(FREE_DAILY_LIMIT);
  });

  it('unlocks 1000 daily requests for 30 days after a recharge of 10 units', () => {
    const db = createDb();
    expect(activateRechargedFreeTier(db, 1, 9_999_999)).toBe(false);
    expect(activateRechargedFreeTier(db, 1, 10_000_000)).toBe(true);
    const access = consumeFreeModelRequest(db, 1);
    expect(access.allowed).toBe(true);
    expect(access.limit).toBe(RECHARGED_DAILY_LIMIT);
    expect(access.upgradedUntil).not.toBeNull();
  });

  it('calculates available balance after existing reservations', () => {
    const db = createDb();
    expect(getAvailableBalanceMicro(db, 1)).toBe(1_750_000);
    expect(getAvailableBalanceMicro(db, 1)).toBeGreaterThan(PAID_MODEL_MINIMUM_BALANCE_MICRO);
  });
});
