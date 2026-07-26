import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { createCodexAccount } from '../../services/codex-oauth.js';

describe('Codex OAuth account authorization defaults', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrationsSync(db, 'up');
  });
  afterEach(() => db.close());

  const credentials = (accountId: string) => ({
    label: `${accountId}@example.com`,
    account_id: accountId,
    access_token_encrypted: 'access',
    access_token_iv: 'iv',
    access_token_auth_tag: 'tag',
    refresh_token_encrypted: 'refresh',
    refresh_token_iv: 'iv',
    refresh_token_auth_tag: 'tag',
  });

  it('keeps new and reauthorized accounts disabled until an administrator enables them', () => {
    const id = createCodexAccount(db, credentials('account-1'));
    expect(db.prepare('SELECT enabled FROM codex_oauth_accounts WHERE id = ?').get(id)).toEqual({ enabled: 0 });

    db.prepare('UPDATE codex_oauth_accounts SET enabled = 1 WHERE id = ?').run(id);
    expect(createCodexAccount(db, credentials('account-1'))).toBe(id);
    expect(db.prepare('SELECT enabled FROM codex_oauth_accounts WHERE id = ?').get(id)).toEqual({ enabled: 0 });
  });
});
