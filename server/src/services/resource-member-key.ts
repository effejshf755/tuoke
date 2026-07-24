import type { Db } from '../db/types.js';

function validKeyForMember(db: Db, memberId: number, userId: number): number | null {
  const row = db.prepare(`SELECT k.id
    FROM resource_subpool_members m
    JOIN consumer_api_keys k ON k.id = m.consumer_api_key_id
    WHERE m.id = ? AND m.user_id = ? AND k.user_id = ?
      AND k.key_scope = 'resource_subpool' AND k.status = 'active' AND k.enabled = 1
      AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))`).get(
    memberId, userId, userId,
  ) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Attach one unused, active Codex key to an existing resource member. */
export function bindAvailableCodexPoolKey(db: Db, memberId: number, userId: number): number | null {
  return db.transaction(() => {
    const existing = validKeyForMember(db, memberId, userId);
    if (existing !== null) return existing;

    const key = db.prepare(`SELECT k.id
      FROM consumer_api_keys k
      LEFT JOIN resource_subpool_members used ON used.consumer_api_key_id = k.id
      WHERE k.user_id = ? AND k.key_scope = 'resource_subpool'
        AND k.status = 'active' AND k.enabled = 1
        AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))
        AND used.id IS NULL
      ORDER BY k.id DESC LIMIT 1`).get(userId) as { id: number } | undefined;
    if (!key) return null;

    const updated = db.prepare(`UPDATE resource_subpool_members
      SET consumer_api_key_id = ? WHERE id = ? AND user_id = ?`).run(key.id, memberId, userId);
    return updated.changes === 1 ? key.id : null;
  })();
}

/** Bind a newly-created Codex key to the oldest entitlement that lacks a valid key. */
export function bindNewCodexPoolKey(db: Db, userId: number, keyId: number): number | null {
  return db.transaction(() => {
    const member = db.prepare(`SELECT m.id
      FROM resource_subpool_members m
      LEFT JOIN consumer_api_keys current_key ON current_key.id = m.consumer_api_key_id
      JOIN resource_subpools s ON s.id = m.subpool_id
      WHERE m.user_id = ? AND m.status IN ('waiting','active')
        AND s.status IN ('waiting_members','waiting_resource','active','paused')
        AND (m.consumer_api_key_id IS NULL OR current_key.status <> 'active'
          OR current_key.enabled <> 1
          OR (current_key.expires_at IS NOT NULL AND datetime(current_key.expires_at) <= datetime('now')))
      ORDER BY m.id ASC LIMIT 1`).get(userId) as { id: number } | undefined;
    if (!member) return null;
    const updated = db.prepare(`UPDATE resource_subpool_members SET consumer_api_key_id = ?
      WHERE id = ? AND user_id = ?`).run(keyId, member.id, userId);
    return updated.changes === 1 ? member.id : null;
  })();
}
