import type { Db } from '../types.js';

export function up(db: Db): void {
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  const requestColumns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!userColumns.some((column) => column.name === 'balance_micro')) db.exec('ALTER TABLE users ADD COLUMN balance_micro INTEGER NOT NULL DEFAULT 0 CHECK (balance_micro >= 0)');
  if (!requestColumns.some((column) => column.name === 'billing_amount_micro')) db.exec('ALTER TABLE requests ADD COLUMN billing_amount_micro INTEGER NOT NULL DEFAULT 0');
  if (!requestColumns.some((column) => column.name === 'billing_status')) db.exec("ALTER TABLE requests ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'unbilled' CHECK (billing_status IN ('unbilled','charged','free','exempt'))");
  db.exec(`
    /*
     * 用户预充值余额
     *
     * 为避免 JavaScript 浮点金额误差，
     * 所有金额统一保存为微单位：
     *
     * 1 元 = 1,000,000 micro
     *
     * 例如：
     * 10.50 元 = 10,500,000 micro
     */
    /*
     * 模型计费规则
     *
     * 不直接修改 models 表，
     * 避免模型目录同步或 Provider 更新影响计费配置。
     *
     * platform + model_id 唯一定位一个模型。
     */
    CREATE TABLE IF NOT EXISTS model_billing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,

      /*
       * 每 100 万 Token 的基础价格。
       *
       * 单位仍然是 micro。
       *
       * 例如：
       * ¥2 / 1M input tokens
       * 保存为 2000000
       */
      input_price_micro_per_million INTEGER NOT NULL DEFAULT 0
        CHECK (input_price_micro_per_million >= 0),

      output_price_micro_per_million INTEGER NOT NULL DEFAULT 0
        CHECK (output_price_micro_per_million >= 0),

      /*
       * 倍率使用千分制整数保存，避免浮点误差：
       *
       * 1000 = 1.000x
       * 1500 = 1.500x
       * 2000 = 2.000x
       */
      multiplier_milli INTEGER NOT NULL DEFAULT 1000
        CHECK (multiplier_milli >= 0),

      billing_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (billing_enabled IN (0, 1)),

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      UNIQUE(platform, model_id)
    );

    /*
     * 用户资金流水
     *
     * delta_micro：
     *
     * 正数 = 充值 / 管理员加款 / 退款
     * 负数 = API 消费 / 管理员扣款
     */
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      type TEXT NOT NULL
        CHECK (
          type IN (
            'recharge',
            'usage',
            'refund',
            'admin_adjustment'
          )
        ),

      delta_micro INTEGER NOT NULL,

      balance_after_micro INTEGER NOT NULL
        CHECK (balance_after_micro >= 0),

      request_id INTEGER
        REFERENCES requests(id)
        ON DELETE SET NULL,

      platform TEXT,
      model_id TEXT,

      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,

      /*
       * 保存当次实际使用的倍率，
       * 即使管理员以后修改倍率，
       * 历史账单仍然可以准确追溯。
       */
      multiplier_milli INTEGER,

      /*
       * 保存当次基础价格快照。
       */
      input_price_micro_per_million INTEGER,
      output_price_micro_per_million INTEGER,

      note TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /*
     * 请求表增加最终计费结果。
     *
     * billing_status：
     *
     * unbilled  = 尚未计费
     * charged   = 已扣费
     * free      = 免费调用
     * exempt    = 管理员/系统免计费调用
     */
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user
      ON wallet_transactions(user_id);

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created
      ON wallet_transactions(created_at);

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_request
      ON wallet_transactions(request_id);

    CREATE INDEX IF NOT EXISTS idx_model_billing_lookup
      ON model_billing_rules(platform, model_id);

    CREATE INDEX IF NOT EXISTS idx_requests_billing_status
      ON requests(billing_status);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_billing_status;
    DROP INDEX IF EXISTS idx_model_billing_lookup;
    DROP INDEX IF EXISTS idx_wallet_transactions_request;
    DROP INDEX IF EXISTS idx_wallet_transactions_created;
    DROP INDEX IF EXISTS idx_wallet_transactions_user;

    DROP TABLE IF EXISTS wallet_transactions;
    DROP TABLE IF EXISTS model_billing_rules;
  `);

  /*
   * users.balance_micro 和 requests 新增字段
   * 在 SQLite 中安全删除需要重建表，
   * 因此 down 不自动删除这些列。
   */
}
