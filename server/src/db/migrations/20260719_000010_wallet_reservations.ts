import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'reserved_balance_micro')) return;
  db.exec(`
    /*
     * 用户已冻结余额。
     *
     * balance_micro = 总余额
     * reserved_balance_micro = 正在执行中的请求预占金额
     *
     * 可用余额：
     * balance_micro - reserved_balance_micro
     */
    ALTER TABLE users
      ADD COLUMN reserved_balance_micro INTEGER NOT NULL DEFAULT 0
      CHECK (reserved_balance_micro >= 0);

    /*
     * 每次消费者 API 请求的余额预授权记录。
     *
     * requested_model:
     * 用户原始请求的 model。
     *
     * reserved_micro:
     * 请求开始前冻结的最大预估费用。
     *
     * actual_micro:
     * 请求完成后的实际费用。
     */
    CREATE TABLE IF NOT EXISTS wallet_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      consumer_api_key_id INTEGER
        REFERENCES consumer_api_keys(id)
        ON DELETE SET NULL,

      request_id INTEGER
        REFERENCES requests(id)
        ON DELETE SET NULL,

      requested_model TEXT,

      reserved_micro INTEGER NOT NULL
        CHECK (reserved_micro >= 0),

      actual_micro INTEGER,

      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (
          status IN (
            'reserved',
            'settled',
            'released',
            'failed'
          )
        ),

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_reservations_user
      ON wallet_reservations(user_id);

    CREATE INDEX IF NOT EXISTS idx_wallet_reservations_status
      ON wallet_reservations(status);

    CREATE INDEX IF NOT EXISTS idx_wallet_reservations_request
      ON wallet_reservations(request_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_wallet_reservations_request;
    DROP INDEX IF EXISTS idx_wallet_reservations_status;
    DROP INDEX IF EXISTS idx_wallet_reservations_user;

    DROP TABLE IF EXISTS wallet_reservations;
  `);

  /*
   * SQLite 安全删除 users.reserved_balance_micro
   * 需要重建 users 表，所以这里不自动删除。
   */
}
