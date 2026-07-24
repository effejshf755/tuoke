import express, { type Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { codexOauthRouter } from '../../routes/codex-oauth.js';

async function remove(app: Express, id: number) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/codex/accounts/${id}`, { method: 'DELETE' });
  const body = await response.json();
  server.close();
  return { status: response.status, body };
}

function account(label: string): number {
  return Number(getDb().prepare(`INSERT INTO codex_oauth_accounts (
    label, access_token_encrypted, access_token_iv, access_token_auth_tag,
    refresh_token_encrypted, refresh_token_iv, refresh_token_auth_tag
  ) VALUES (?, 'x', 'x', 'x', 'x', 'x', 'x')`).run(label).lastInsertRowid);
}

describe('administrator Codex account deletion', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '5'.repeat(64);
    initDb(':memory:');
    app = express();
    app.use(express.json());
    app.use('/api/admin/codex', codexOauthRouter);
  });

  it('connects the canonical account-page endpoint and hides a deleted account', async () => {
    const id = account('deletable');
    const result = await remove(app, id);
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(getDb().prepare(`SELECT enabled, status, deleted_at deletedAt
      FROM codex_oauth_accounts WHERE id = ?`).get(id)).toMatchObject({ enabled: 0, status: 'deleted' });
  });

  it('rejects deletion while the account is assigned to a resource subpool', async () => {
    const id = account('assigned');
    const subpoolId = Number(getDb().prepare(`INSERT INTO resource_subpools
      (name, mode, status, member_limit, pending_codex_account_id)
      VALUES ('assigned', 'dedicated', 'waiting_resource', 2, ?)`).run(id).lastInsertRowid);
    const result = await remove(app, id);
    expect(result.status).toBe(409);
    expect(result.body.error.type).toBe('account_in_use');
    expect(getDb().prepare('SELECT deleted_at deletedAt FROM codex_oauth_accounts WHERE id = ?').get(id))
      .toEqual({ deletedAt: null });
    getDb().prepare('DELETE FROM resource_subpools WHERE id = ?').run(subpoolId);
  });

  it('is idempotent from the UI perspective and returns not found after deletion', async () => {
    const id = account('delete-once');
    expect((await remove(app, id)).status).toBe(200);
    expect((await remove(app, id)).status).toBe(404);
  });
});
