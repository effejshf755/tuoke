import type { Db } from '../db/types.js';

function validKeyForMember(db: Db, memberId: number, userId: number): number | null {
  const row = db.prepare(`SELECT k.id
    FROM resource_subpool_members m
    JOIN resource_member_api_keys mk ON mk.member_id = m.id
    JOIN consumer_api_keys k ON k.id = mk.consumer_api_key_id
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
      LEFT JOIN resource_member_api_keys used ON used.consumer_api_key_id = k.id
      WHERE k.user_id = ? AND k.key_scope = 'resource_subpool'
        AND k.status = 'active' AND k.enabled = 1
        AND (k.expires_at IS NULL OR datetime(k.expires_at) > datetime('now'))
        AND used.id IS NULL
      ORDER BY k.id DESC LIMIT 1`).get(userId) as { id: number } | undefined;
    if (!key) return null;

    const inserted = db.prepare(`INSERT OR IGNORE INTO resource_member_api_keys
      (member_id, consumer_api_key_id) SELECT id, ? FROM resource_subpool_members
      WHERE id = ? AND user_id = ?`).run(key.id, memberId, userId);
    if (inserted.changes !== 1) return null;
    db.prepare(`UPDATE resource_subpool_members SET consumer_api_key_id = COALESCE(consumer_api_key_id, ?)
      WHERE id = ?`).run(key.id, memberId);
    return key.id;
  })();
}

/** Bind every new Codex resource key to the user's best current entitlement. */
export function bindNewCodexPoolKey(db: Db, userId: number, keyId: number): number | null {
  return db.transaction(() => {
    const member = db.prepare(`SELECT m.id
      FROM resource_subpool_members m
      JOIN resource_subpools s ON s.id = m.subpool_id
      WHERE m.user_id = ? AND m.status IN ('waiting','active')
        AND s.status IN ('waiting_members','waiting_resource','active','paused')
      ORDER BY
        CASE WHEN s.status = 'active' AND EXISTS (
          SELECT 1 FROM resource_subpool_quota_periods p
          JOIN resource_member_quotas q ON q.subpool_period_id = p.id AND q.member_id = m.id AND q.status = 'active'
          WHERE p.subpool_id = s.id AND p.status = 'active'
            AND datetime(p.starts_at) <= datetime('now')
            AND (p.resets_at IS NULL OR datetime(p.resets_at) > datetime('now'))
        ) THEN 0 WHEN s.status = 'active' THEN 1 WHEN s.status IN ('waiting_members','waiting_resource') THEN 2 ELSE 3 END,
        m.id ASC LIMIT 1`).get(userId) as { id: number } | undefined;
    if (!member) return null;
    const inserted = db.prepare(`INSERT OR IGNORE INTO resource_member_api_keys
      (member_id, consumer_api_key_id) VALUES (?, ?)`).run(member.id, keyId);
    if (inserted.changes !== 1) return null;
    db.prepare(`UPDATE resource_subpool_members SET consumer_api_key_id = COALESCE(consumer_api_key_id, ?)
      WHERE id = ?`).run(keyId, member.id);
    return member.id;
  })();
}
