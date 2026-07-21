import type { Db } from '../types.js';
export function up(db: Db): void {
  const hasBonusIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_wallet_bonus_once'").get();
  if (hasBonusIndex) return;
  db.pragma('foreign_keys = OFF');
  db.exec(`ALTER TABLE wallet_transactions RENAME TO wallet_transactions_old;
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('recharge','usage','refund','admin_adjustment','bonus')),
      delta_micro INTEGER NOT NULL, balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro >= 0),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL, platform TEXT, model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, multiplier_milli INTEGER,
      input_price_micro_per_million INTEGER, output_price_micro_per_million INTEGER, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO wallet_transactions SELECT * FROM wallet_transactions_old;
    DROP TABLE wallet_transactions_old;
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_bonus_once ON wallet_transactions(user_id) WHERE type = 'bonus';`);
  db.pragma('foreign_keys = ON');
}
export function down(db: Db): void {
  const bonusRows = db.prepare("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'bonus'").get() as { count: number };
  if (bonusRows.count > 0) throw new Error('Cannot reverse bonus wallet migration while bonus rows exist');
  db.pragma('foreign_keys = OFF');
  db.exec(`ALTER TABLE wallet_transactions RENAME TO wallet_transactions_bonus;
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('recharge','usage','refund','admin_adjustment')),
      delta_micro INTEGER NOT NULL, balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro >= 0),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL, platform TEXT, model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, multiplier_milli INTEGER,
      input_price_micro_per_million INTEGER, output_price_micro_per_million INTEGER, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO wallet_transactions SELECT * FROM wallet_transactions_bonus;
    DROP TABLE wallet_transactions_bonus;
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);`);
  db.pragma('foreign_keys = ON');
}
