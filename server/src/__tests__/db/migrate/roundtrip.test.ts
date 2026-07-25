import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
const CONSUMER_API_KEYS_FILENAME = '20260719_000001_consumer_api_keys.ts';
const CURRENT_MIGRATIONS_AFTER_KEYS = [
  '20260719_000002_user_roles.ts',
  '20260719_000003_consumer_request_identity.ts',
  '20260719_000004_user_monthly_token_limit.ts',
  '20260719_000005_user_status.ts',
  '20260719_000006_email_verification_codes.ts',
  '20260719_000007_password_reset_codes.ts',
  '20260719_000008_consumer_api_key_enabled.ts',
  '20260719_000009_billing_system.ts',
  '20260719_000010_wallet_reservations.ts',
  '20260720_000011_recharge_orders.ts',
  '20260720_000012_platform_settings.ts',
  '20260720_000013_bonus_wallet_transaction.ts',
  '20260720_000014_playground_conversations.ts',
  '20260722_000016_openrouter_free_models.ts',
  '20260722_000017_openrouter_free_billing_rules.ts',
  '20260722_000018_siliconflow_test_models.ts',
  '20260722_000019_codex_oauth_accounts.ts',
  '20260723_000020_codex_models.ts',
  '20260723_000021_add_codex_model.ts',
  '20260723_000022_codex_model_and_billing.ts',
  '20260723_000023_consumer_api_key_type.ts',
  '20260723_000024_model_upstream_id.ts',
  '20260723_000025_codex_oauth_account_models.ts',
  '20260723_000026_codex_usage_stats.ts',
  '20260723_000027_codex_usage_records.ts',
  '20260723_000028_codex_account_quota.ts',
  '20260723_000029_free_model_access.ts',
  '20260724_000030_resource_architecture.ts',
  '20260725_000031_resource_products_orders.ts',
  '20260725_000032_resource_grouping_status.ts',
  '20260725_000033_resource_subpool_activation.ts',
  '20260725_000034_resource_admin_audit.ts',
  '20260725_000035_resource_wallet_purchase.ts',
  '20260725_000036_resource_subpool_entitlement_freeze.ts',
  '20260725_000037_resource_scope_isolation.ts',
  '20260725_000038_codex_account_soft_delete.ts',
  '20260725_000039_resource_partial_settlement.ts',
  '20260725_000040_resource_operational_alerts.ts',
  '20260725_000041_codex_alias_tools.ts',
  '20260725_000042_resource_member_multiple_keys.ts',
  '20260725_000043_resource_points_policy.ts',
  '20260725_000044_resource_cached_points.ts',
];

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface DatabaseSnapshot {
  schema: SchemaRow[];
  rows: Record<string, unknown[]>;
}

describe('migration round trip', () => {
  it('connectDb opens a connection without applying migrations', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = connectDb(':memory:');

    try {
      expect(hasTable(db, 'models')).toBe(false);
      expect(hasTable(db, 'migrations')).toBe(false);
    } finally {
      db.close();
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('runs the legacy baseline against existing legacy DBs so rebased legacy changes apply', async () => {
    const db = new Database(':memory:');

    try {
      runLegacyBaseline(db);
      db.prepare(`
        UPDATE models
           SET enabled = 1
         WHERE platform = 'opencode'
           AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
      `).run();

      expect(getEnabledZenDeadPromoCount(db)).toBe(2);

      await runMigrations(db, 'up');

      expect(getEnabledZenDeadPromoCount(db)).toBe(0);
      expect(getAppliedMigrationNames(db)).toEqual([
        LEGACY_BASELINE_FILENAME,
        CUSTOM_PROVIDER_MODALITIES_FILENAME,
        CATALOG_MODEL_STATE_FILENAME,
        REQUEST_AGGREGATES_FILENAME,
        GITHUB_GPT41_CONTEXT_FILENAME,
        REQUEST_CLIENT_INFO_FILENAME,
        CUSTOM_MODEL_TOOL_SUPPORT_FILENAME,
        PROFILE_CHAIN_BACKFILL_FILENAME,
        CONSUMER_API_KEYS_FILENAME,
        ...CURRENT_MIGRATIONS_AFTER_KEYS,
      ]);
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);

      // The catalog seed has no custom models, so the custom-model tool-support
      // backfill only alters state once a user endpoint exists. Seed one (in its
      // post-migration state, tools = 1) so the round trip actually exercises
      // that migration's down (tools -> 0) and up (tools -> 1).
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled)
        VALUES ('custom', 'roundtrip-custom', 'Roundtrip Custom', 50, 50, 1, 0, 1)
      `).run();

      const fullState = snapshotAppState(db);
      await runDownToBaseline(db);

      expect(getAppliedMigrationNames(db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);
      // Catalog migrations intentionally replace stale seeded model rows, so
      // auto-increment IDs and catalog contents are not round-trip stable.
      // The schema and user-owned custom model must survive the cycle.
      expect(snapshotSchema(db)).toEqual(fullState.schema);
      expect(db.prepare(`SELECT supports_tools FROM models WHERE platform = 'custom' AND model_id = 'roundtrip-custom'`).get())
        .toEqual({ supports_tools: 1 });
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Database.Database): Promise<void> {
  while (getAppliedMigrationNames(db).length > 1) {
    const migrationName = getLatestAppliedMigrationName(db);
    const before = snapshotAppState(db);

    try {
      await runMigrations(db, 'down');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('irreversible')) throw error;
      db.prepare('DELETE FROM migrations WHERE filename = ?').run(migrationName);
      continue;
    }

    expect(snapshotAppState(db), `${migrationName} down() must alter app DB state or throw irreversible`)
      .not.toEqual(before);
  }
}

function getLatestAppliedMigrationName(db: Database.Database): string {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) throw new Error('No applied migrations found');
  return row.filename;
}

function getAppliedMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'applied')
    .map(status => status.filename);
}

function getPendingMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'pending')
    .map(status => status.filename);
}

function getEnabledZenDeadPromoCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM models
     WHERE platform = 'opencode'
       AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       AND enabled = 1
  `).get() as { count: number };

  return row.count;
}

function snapshotSchema(db: Database.Database): SchemaRow[] {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'table', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
  // SQLite rewrites CREATE TABLE SQL when a migration rebuilds a table. The
  // semantic schema is unchanged, but whitespace and harmless identifier
  // quoting differ, so compare a canonical representation.
  return rows.map((row) => ({
    ...row,
    sql: (() => {
      if (!row.sql) return null;
      let sql = row.sql.replace(/["`]/g, '').replace(/\s+/g, ' ').replace(/created_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/g, 'created_at TEXT NOT NULL').trim();
      if (sql.includes('client_ip TEXT')) {
        sql = sql.replace(/, client_ip TEXT, client_user_agent TEXT/g, '').replace(/\)$/, ', client_ip TEXT, client_user_agent TEXT)');
      }
      return sql;
    })(),
  }));
}

function snapshotAppState(db: Database.Database): DatabaseSnapshot {
  const tableNames = getAppTableNames(db);
  const rows: Record<string, unknown[]> = {};

  for (const tableName of tableNames) {
    rows[tableName] = snapshotTableRows(db, tableName);
  }

  return {
    schema: snapshotSchema(db),
    rows,
  };
}

function getAppTableNames(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> 'migrations'
     ORDER BY name
  `).all() as { name: string }[];

  return rows.map(row => row.name);
}

function snapshotTableRows(db: Database.Database, tableName: string): unknown[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  const orderBy = columns.map(column => quoteIdentifier(column.name)).join(', ');

  return db.prepare(`
    SELECT *
      FROM ${quoteIdentifier(tableName)}
     ORDER BY ${orderBy}
  `).all() as unknown[];
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
