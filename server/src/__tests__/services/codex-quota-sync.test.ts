import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { syncEnabledCodexAccountQuotas } from '../../services/codex-oauth.js';

describe('Codex account quota synchronization', () => {
  it('checks every enabled non-deleted account and skips disabled accounts', async () => {
    const db = new Database(':memory:');
    runMigrationsSync(db, 'up');
    const insert = db.prepare(`INSERT INTO codex_oauth_accounts (
      label, access_token_encrypted, access_token_iv, access_token_auth_tag,
      refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag, enabled
    ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x', ?)`);
    const first = Number(insert.run('first', 1).lastInsertRowid);
    const second = Number(insert.run('second', 1).lastInsertRowid);
    insert.run('disabled', 0);
    const checked: number[] = [];

    const count = await syncEnabledCodexAccountQuotas(db, async (_db, id) => {
      checked.push(id);
    });

    expect(count).toBe(2);
    expect(checked).toEqual([first, second]);
    db.close();
  });
});
