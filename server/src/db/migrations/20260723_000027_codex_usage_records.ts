import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER
        REFERENCES codex_oauth_accounts(id)
        ON DELETE SET NULL,
      account_label TEXT NOT NULL,
      model_id TEXT NOT NULL,
      consumer_user_id INTEGER
        REFERENCES users(id)
        ON DELETE SET NULL,
      api_key_id INTEGER
        REFERENCES consumer_api_keys(id)
        ON DELETE SET NULL,
      request_id INTEGER
        REFERENCES requests(id)
        ON DELETE SET NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0
        CHECK (success IN (0, 1)),
      error TEXT,
      billing_amount_micro INTEGER NOT NULL DEFAULT 0,
      billing_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (billing_status IN ('pending', 'charged', 'free', 'exempt', 'failed')),
      input_price_micro_per_million INTEGER,
      output_price_micro_per_million INTEGER,
      multiplier_milli INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_codex_usage_records_account
      ON codex_usage_records(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_usage_records_model
      ON codex_usage_records(model_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_usage_records_user
      ON codex_usage_records(consumer_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_codex_usage_records_request
      ON codex_usage_records(request_id);

    /*
     * Every discovered Codex capability gets an explicit, initially free,
     * billing rule. Administrators can then price each real upstream model
     * independently without changing the public model=codex alias.
     */
    INSERT OR IGNORE INTO model_billing_rules (
      platform,
      model_id,
      input_price_micro_per_million,
      output_price_micro_per_million,
      multiplier_milli,
      billing_enabled
    )
    SELECT
      'openai-codex',
      model_id,
      0,
      0,
      1000,
      1
    FROM codex_oauth_account_models
    GROUP BY model_id;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_codex_usage_records_request;
    DROP INDEX IF EXISTS idx_codex_usage_records_user;
    DROP INDEX IF EXISTS idx_codex_usage_records_model;
    DROP INDEX IF EXISTS idx_codex_usage_records_account;
    DROP TABLE IF EXISTS codex_usage_records;
  `);
}
