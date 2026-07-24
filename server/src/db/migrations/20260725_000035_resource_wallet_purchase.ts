import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE resource_orders ADD COLUMN purchase_idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_orders_purchase_idempotency
      ON resource_orders(purchase_idempotency_key)
      WHERE purchase_idempotency_key IS NOT NULL;

    ALTER TABLE wallet_transactions RENAME TO wallet_transactions_before_resource_purchase;
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN (
        'recharge','usage','refund','admin_adjustment','bonus','purchase','purchase_refund'
      )),
      delta_micro INTEGER NOT NULL,
      balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro >= 0),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      resource_order_id INTEGER REFERENCES resource_orders(id) ON DELETE SET NULL,
      platform TEXT,
      model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      multiplier_milli INTEGER,
      input_price_micro_per_million INTEGER,
      output_price_micro_per_million INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO wallet_transactions (
      id, user_id, type, delta_micro, balance_after_micro, request_id,
      platform, model_id, input_tokens, output_tokens, multiplier_milli,
      input_price_micro_per_million, output_price_micro_per_million, note, created_at
    ) SELECT id, user_id, type, delta_micro, balance_after_micro, request_id,
      platform, model_id, input_tokens, output_tokens, multiplier_milli,
      input_price_micro_per_million, output_price_micro_per_million, note, created_at
      FROM wallet_transactions_before_resource_purchase;
    DROP TABLE wallet_transactions_before_resource_purchase;

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created ON wallet_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_request ON wallet_transactions(request_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_bonus_once
      ON wallet_transactions(user_id) WHERE type = 'bonus';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_resource_purchase_once
      ON wallet_transactions(resource_order_id) WHERE type = 'purchase';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_resource_refund_once
      ON wallet_transactions(resource_order_id) WHERE type = 'purchase_refund';
  `);
}

export function down(db: Db): void {
  const commerceRows = db.prepare(`SELECT COUNT(*) count FROM wallet_transactions WHERE type IN ('purchase','purchase_refund')`).get() as { count: number };
  if (commerceRows.count > 0) throw new Error('Cannot reverse resource wallet purchase migration while purchase rows exist');
  db.exec(`
    DROP INDEX IF EXISTS idx_wallet_resource_refund_once;
    DROP INDEX IF EXISTS idx_wallet_resource_purchase_once;
    ALTER TABLE wallet_transactions RENAME TO wallet_transactions_resource_purchase;
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('recharge','usage','refund','admin_adjustment','bonus')),
      delta_micro INTEGER NOT NULL,
      balance_after_micro INTEGER NOT NULL CHECK(balance_after_micro >= 0),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      platform TEXT,
      model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      multiplier_milli INTEGER,
      input_price_micro_per_million INTEGER,
      output_price_micro_per_million INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO wallet_transactions (
      id, user_id, type, delta_micro, balance_after_micro, request_id,
      platform, model_id, input_tokens, output_tokens, multiplier_milli,
      input_price_micro_per_million, output_price_micro_per_million, note, created_at
    ) SELECT id, user_id, type, delta_micro, balance_after_micro, request_id,
      platform, model_id, input_tokens, output_tokens, multiplier_milli,
      input_price_micro_per_million, output_price_micro_per_million, note, created_at
      FROM wallet_transactions_resource_purchase;
    DROP TABLE wallet_transactions_resource_purchase;
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created ON wallet_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_request ON wallet_transactions(request_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_bonus_once
      ON wallet_transactions(user_id) WHERE type = 'bonus';
    DROP INDEX IF EXISTS idx_resource_orders_purchase_idempotency;
    ALTER TABLE resource_orders DROP COLUMN purchase_idempotency_key;
  `);
}
