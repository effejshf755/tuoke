import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(codex_oauth_accounts)`).all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has('quota_used_percent')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN quota_used_percent REAL`);
  }
  if (!has('quota_remaining_percent')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN quota_remaining_percent REAL`);
  }
  if (!has('quota_reset_at')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN quota_reset_at TEXT`);
  }
  if (!has('quota_synced_at')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN quota_synced_at TEXT`);
  }
  if (!has('plan_type')) {
    db.exec(`ALTER TABLE codex_oauth_accounts ADD COLUMN plan_type TEXT`);
  }
}

export function down(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(codex_oauth_accounts)`).all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((column) => column.name === name);
  for (const name of ['plan_type', 'quota_synced_at', 'quota_reset_at', 'quota_remaining_percent', 'quota_used_percent']) {
    if (has(name)) db.exec(`ALTER TABLE codex_oauth_accounts DROP COLUMN ${name}`);
  }
}
