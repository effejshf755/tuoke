import type { Db } from '../db/types.js';
import { recordResourceAdminAudit } from './resource-admin-audit.js';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const phaseFloor = (phase: number, finalFloor: number) => [80, 60, 40, 20, finalFloor][phase - 1] ?? finalFloor;

export function getResourceQuotaStageAnalysis(db: Db, subpoolId: number) {
  const pool = db.prepare(`SELECT s.id, s.status, s.quota_phase quotaPhase,
    s.phase_release_percent phaseReleasePercent,
    s.phase_started_official_percent phaseStartedOfficialPercent,
    s.phase_started_used_units phaseStartedUsedUnits,
    s.phase_released_units phaseReleasedUnits,
    s.phase_multiplier_factor_micros / 1000000.0 phaseMultiplierFactor,
    s.phase_started_at phaseStartedAt,
    s.frozen_member_quota_units promisedMemberUnits,
    p.id periodId, p.allocation_units allocationUnits, p.used_units usedUnits,
    p.reserved_units reservedUnits,
    a.quota_remaining_percent officialRemainingPercent, a.quota_reset_at officialResetAt,
    policy.official_quota_floor_percent finalFloorPercent
    FROM resource_subpools s
    LEFT JOIN resource_subpool_quota_periods p ON p.subpool_id = s.id AND p.status = 'active'
    LEFT JOIN resource_subpool_bindings b ON b.subpool_id = s.id AND b.status = 'active'
    LEFT JOIN codex_oauth_accounts a ON a.id = b.codex_account_id
    JOIN resource_quota_policy policy ON policy.id = 1
    WHERE s.id = ?`).get(subpoolId) as any;
  if (!pool) return null;
  const members = db.prepare(`SELECT m.id memberId, m.user_id userId, u.email,
    q.allocation_units allocationUnits, q.used_units usedUnits, q.reserved_units reservedUnits,
    q.allocation_units - q.used_units - q.reserved_units remainingUnits,
    COALESCE(SUM(r.input_tokens), 0) inputTokens,
    COALESCE(SUM(r.cached_input_tokens), 0) cachedInputTokens,
    COALESCE(SUM(r.output_tokens), 0) outputTokens,
    COALESCE(SUM(r.actual_units), 0) settledPoints
    FROM resource_subpool_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN resource_member_quotas q ON q.member_id = m.id AND q.subpool_period_id = ?
    LEFT JOIN resource_quota_reservations r ON r.member_quota_id = q.id AND r.status = 'settled'
    WHERE m.subpool_id = ? GROUP BY m.id ORDER BY m.id`).all(pool.periodId ?? -1, subpoolId);
  const models = db.prepare(`SELECT COALESCE(r.model_id, 'unknown') modelId,
    COALESCE(SUM(r.input_tokens), 0) inputTokens, COALESCE(SUM(r.cached_input_tokens), 0) cachedInputTokens,
    COALESCE(SUM(r.output_tokens), 0) outputTokens, COALESCE(SUM(r.actual_units), 0) settledPoints,
    COUNT(*) requestCount FROM resource_quota_reservations r
    WHERE r.subpool_id = ? AND r.status = 'settled'
    GROUP BY r.model_id ORDER BY settledPoints DESC, modelId`).all(subpoolId);
  const phase = Number(pool.quotaPhase ?? 5);
  const targetOfficialPercent = phaseFloor(phase, Number(pool.finalFloorPercent));
  const startOfficial = pool.phaseStartedOfficialPercent == null ? null : Number(pool.phaseStartedOfficialPercent);
  const currentOfficial = pool.officialRemainingPercent == null ? null : Number(pool.officialRemainingPercent);
  const phaseUsedUnits = Math.max(0, Number(pool.usedUnits ?? 0) - Number(pool.phaseStartedUsedUnits ?? 0));
  const phaseAllocationUnits = Math.max(0, Number(pool.allocationUnits ?? 0) - Number(pool.phaseStartedUsedUnits ?? 0));
  const officialTargetUse = startOfficial == null ? 0 : Math.max(0, startOfficial - targetOfficialPercent);
  const officialObservedUse = startOfficial == null || currentOfficial == null ? null : Math.max(0, startOfficial - currentOfficial);
  const officialProgress = officialObservedUse == null || officialTargetUse <= 0 ? null : officialObservedUse / officialTargetUse;
  const pointsProgress = phaseAllocationUnits > 0 ? phaseUsedUnits / phaseAllocationUnits : 0;
  const suggestedMultiplierFactor = officialProgress != null && officialProgress > 0 && pointsProgress > 0
    ? Math.round(clamp(Number(pool.phaseMultiplierFactor) * officialProgress / pointsProgress, 0.001, 100) * 1_000_000) / 1_000_000
    : Number(pool.phaseMultiplierFactor ?? 1);
  const phaseReady = phase < 5 && Number(pool.reservedUnits ?? 0) === 0
    && ((currentOfficial != null && currentOfficial <= targetOfficialPercent)
      || Number(pool.usedUnits ?? 0) >= Number(pool.allocationUnits ?? 0));
  return { ...pool, targetOfficialPercent, phaseUsedUnits, phaseAllocationUnits,
    officialObservedUse, officialTargetUse, suggestedMultiplierFactor, phaseReady, members, models };
}

export function releaseResourceQuotaStageTwo(db: Db, input: { subpoolId: number; adminId: number; multiplierFactor?: number }) {
  const factor = Number(input.multiplierFactor ?? 1);
  if (!Number.isFinite(factor) || factor < 0.001 || factor > 100) throw new Error('Phase multiplier must be between 0.001 and 100');
  return db.transaction(() => {
    const analysis = getResourceQuotaStageAnalysis(db, input.subpoolId) as any;
    if (!analysis) throw new Error('Resource subpool was not found');
    if (!analysis.phaseReady || analysis.quotaPhase >= 5) throw new Error('Current quota phase has not reached its boundary');
    if (!['active', 'paused'].includes(analysis.status)) throw new Error('Subpool must be active or paused');
    if (!analysis.periodId || !analysis.promisedMemberUnits) throw new Error('Active quota entitlement is incomplete');
    const nextPhase = Number(analysis.quotaPhase) + 1;
    const targetMemberUnits = Math.floor(Number(analysis.promisedMemberUnits) * nextPhase / 5);
    const quotas = db.prepare(`SELECT q.id quotaId, q.member_id memberId, q.allocation_units allocationUnits,
      q.used_units usedUnits, q.reserved_units reservedUnits FROM resource_member_quotas q
      JOIN resource_subpool_members m ON m.id = q.member_id
      WHERE q.subpool_period_id = ? AND q.status = 'active' AND m.subpool_id = ? ORDER BY q.member_id`)
      .all(analysis.periodId, input.subpoolId) as any[];
    if (!quotas.length || quotas.some(q => q.reservedUnits !== 0)) throw new Error('Wait for in-flight quota reservations');
    for (const quota of quotas) {
      if (targetMemberUnits < quota.usedUnits) throw new Error(`Member ${quota.memberId} exceeds next phase allocation`);
      const delta = Math.max(0, targetMemberUnits - quota.allocationUnits);
      if (!delta) continue;
      db.prepare(`UPDATE resource_member_quotas SET allocation_units = ? WHERE id = ?`).run(targetMemberUnits, quota.quotaId);
      db.prepare(`INSERT INTO resource_quota_ledger (subpool_id, period_id, member_id, type, delta_units, balance_after_units, reason)
        VALUES (?, ?, ?, 'adjustment', ?, ?, ?)`).run(input.subpoolId, analysis.periodId, quota.memberId,
          delta, targetMemberUnits - quota.usedUnits, `quota phase ${nextPhase} release`);
    }
    const poolAllocation = targetMemberUnits * quotas.length;
    db.prepare(`UPDATE resource_subpool_quota_periods SET allocation_units = ? WHERE id = ?`).run(poolAllocation, analysis.periodId);
    db.prepare(`UPDATE resource_subpools SET quota_phase = ?, phase_started_official_percent = ?,
      phase_started_used_units = ?, phase_released_units = ?, phase_multiplier_factor_micros = ?,
      phase_started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
        nextPhase, analysis.officialRemainingPercent, analysis.usedUnits, poolAllocation,
        Math.round(factor * 1_000_000), input.subpoolId);
    recordResourceAdminAudit(db, { adminUserId: input.adminId, action: 'quota_phase_released',
      targetType: 'resource_subpool', targetId: input.subpoolId, subpoolId: input.subpoolId,
      details: { fromPhase: analysis.quotaPhase, toPhase: nextPhase, multiplierFactor: factor, poolAllocation } });
    return getResourceQuotaStageAnalysis(db, input.subpoolId);
  })();
}
