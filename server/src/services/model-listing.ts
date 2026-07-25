import type { ModelListRow } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';
import { getModelHealthMap } from './model-health.js';

// Shared catalog-listing logic behind both the OpenAI `GET /v1/models` and the
// Anthropic `GET /v1/models` endpoints, so the two wire formats list the exact
// same models (only the envelope differs). Extracted verbatim from the OpenAI
// proxy route to keep a single source of truth.

export interface NormalizedModel {
  id: string;
  name: string;
  ownedBy: string;
  available: number;
  enabled: number;
  contextWindow: number | null;
  intel: number;
  // Platforms that can serve this entry (group members under unify, a single
  // platform otherwise) + tool capability — feeds /v1/models
  // `supported_parameters` so agents can pick knobs per model.
  platforms: string[];
  supportsTools: boolean;
}

export interface ModelListing {
  // Full catalog, sorted usable-first; callers apply their own `available` filter.
  models: NormalizedModel[];
  // Honest ceiling for the virtual "auto" model: the largest context window
  // among models that can serve a request right now (null when nothing is
  // connected). Computed over available models regardless of any caller filter.
  autoContextWindow: number | null;
}

export type CodexConsumerKeyType = 'codex_pool' | 'resource_subpool';

export function normalizeCodexModelId(modelId: string): string {
  return modelId === 'openai-codex/codex' ? 'codex' : modelId;
}

/**
 * Consumer keys must only discover models that can actually be called by a
 * billed user: the model is enabled, an enabled provider key can serve it, and
 * the administrator has enabled a billing rule for it.
 *
 * This deliberately stays a query-time filter. The administrator's catalog
 * and billing pages continue to use the complete model inventory.
 */
export function getConsumerCallableCanonicalIds(): Set<string> {
  const db = getDb();
  const health = getModelHealthMap(db);
  const rows = db.prepare(`
    SELECT DISTINCT m.id AS modelDbId, m.model_id AS modelId, m.platform
    FROM models m
    JOIN model_billing_rules b
      ON b.platform = m.platform
     AND b.model_id = m.model_id
     AND b.billing_enabled = 1
    WHERE m.enabled = 1
      AND m.platform <> 'openai-codex'
      AND (
        EXISTS (
          SELECT 1
          FROM api_keys k
          WHERE k.platform = m.platform
            AND k.enabled = 1
            AND (m.key_id IS NULL OR k.id = m.key_id)
        )
        OR (
        m.platform = 'openai-codex'
        AND EXISTS (
          SELECT 1
          FROM codex_oauth_accounts c
          WHERE c.enabled = 1
            AND c.status IN ('healthy', 'unknown')
            AND (c.cooldown_until IS NULL OR c.cooldown_until <= datetime('now'))
        )
        )
      )
  `).all() as Array<{ modelDbId: number; modelId: string; platform?: string }>;

  const healthyRows = rows.filter(row => health[`${row.platform ?? ''}:${row.modelId}`]?.status !== 'failed');

  if (!isUnifyEnabled()) {
    return new Set(healthyRows.map(row => row.modelId));
  }

  const callableModelDbIds = new Set(healthyRows.map(row => row.modelDbId));
  return new Set(
    getModelGroups()
      .filter(group => group.members.some(member => callableModelDbIds.has(member.model_db_id)))
      .map(group => group.canonicalId),
  );
}

/**
 * Apply the consumer visibility policy to a shared catalog listing.
 * Consumer callers never receive disabled, keyless, or unconfigured models.
 */
export function filterModelListingForConsumer(_listing: ModelListing): ModelListing {
  const callableIds = getConsumerCallableCanonicalIds();
  // Build the consumer view without Codex rows before model-id de-duplication
  // or group aggregation. Filtering the already-aggregated catalog by id can
  // leak Codex ownership/capability metadata when an ordinary provider uses
  // the same model id.
  const ordinaryListing = buildModelListing({ excludeOpenAICodex: true });
  const models = ordinaryListing.models.filter(model =>
    callableIds.has(model.id) && model.available === 1,
  );
  const contextWindows = models
    .map(model => model.contextWindow)
    .filter((value): value is number => value != null);

  return {
    models,
    autoContextWindow: contextWindows.length ? Math.max(...contextWindows) : null,
  };
}

/**
 * Codex keys expose only the real models supported by their permitted OAuth
 * account(s). Ordinary provider models and the internal `codex` alias are
 * intentionally excluded from this listing.
 */
export function filterModelListingForCodexConsumer(
  _listing: ModelListing,
  keyType: CodexConsumerKeyType,
  consumerKeyId: number,
): ModelListing {
  const rows = getCodexConsumerCallableRows(keyType, consumerKeyId);
  const models = rows.map(row => ({
    id: row.modelId,
    name: row.name,
    ownedBy: 'openai-codex',
    available: 1,
    enabled: row.enabled,
    contextWindow: row.contextWindow,
    intel: row.intel,
    platforms: ['openai-codex'],
    supportsTools: row.supportsTools === 1,
  }));
  const contexts = models.map(model => model.contextWindow).filter((value): value is number => value != null);
  return { models, autoContextWindow: contexts.length ? Math.max(...contexts) : null };
}

interface CodexConsumerModelRow {
  modelId: string;
  name: string;
  contextWindow: number | null;
  intel: number;
  enabled: number;
  supportsTools: number;
}

function getCodexConsumerCallableRows(
  keyType: CodexConsumerKeyType,
  consumerKeyId: number,
): CodexConsumerModelRow[] {
  const db = getDb();
  const accountPredicate = keyType === 'codex_pool'
    ? `a.resource_scope = 'codex_pool' AND a.enabled = 1
       AND a.status IN ('healthy', 'unknown')
       AND (a.cooldown_until IS NULL OR a.cooldown_until <= datetime('now'))
       AND (a.quota_remaining_percent IS NULL OR a.quota_remaining_percent > 0
            OR (a.quota_reset_at IS NOT NULL AND datetime(a.quota_reset_at) <= datetime('now')))`
    : `EXISTS (
         SELECT 1 FROM resource_subpool_members sm
         JOIN resource_member_api_keys mk ON mk.member_id = sm.id
         JOIN resource_subpools ss ON ss.id = sm.subpool_id AND ss.status = 'active'
         JOIN resource_subpool_bindings sb ON sb.subpool_id = ss.id AND sb.status = 'active'
         WHERE mk.consumer_api_key_id = ? AND sb.codex_account_id = a.id
       )
       AND a.resource_scope = 'resource_subpool' AND a.enabled = 1
       AND a.status IN ('healthy', 'unknown')
       AND (a.cooldown_until IS NULL OR a.cooldown_until <= datetime('now'))
       AND (a.quota_remaining_percent IS NULL OR a.quota_remaining_percent > 0
            OR (a.quota_reset_at IS NOT NULL AND datetime(a.quota_reset_at) <= datetime('now')))`;
  const params = keyType === 'codex_pool' ? [] : [consumerKeyId];
  return db.prepare(`
    SELECT DISTINCT am.model_id modelId, m.display_name name,
      m.context_window contextWindow, m.intelligence_rank intel,
      m.enabled enabled, m.supports_tools supportsTools
    FROM codex_oauth_accounts a
    JOIN codex_oauth_account_models am ON am.account_id = a.id AND am.enabled = 1
    JOIN models m ON m.platform = 'openai-codex' AND m.model_id = am.model_id AND m.enabled = 1
    JOIN model_billing_rules b ON b.platform = 'openai-codex' AND b.model_id = am.model_id AND b.billing_enabled = 1
    WHERE ${accountPredicate}
      AND am.model_id <> 'codex'
    ORDER BY m.intelligence_rank ASC, am.model_id ASC
  `).all(...params) as CodexConsumerModelRow[];
}

export function getCodexConsumerCallableModelIds(
  keyType: CodexConsumerKeyType,
  consumerKeyId: number,
): Set<string> {
  return new Set(getCodexConsumerCallableRows(keyType, consumerKeyId).map(row => row.modelId));
}

/** Resolve an explicit Codex model against the accounts available to one key. */
export function getCodexConsumerModelDbId(
  keyType: CodexConsumerKeyType,
  consumerKeyId: number,
  requestedModel: string,
): number | null {
  const modelId = normalizeCodexModelId(requestedModel);
  if (modelId !== 'codex' && !getCodexConsumerCallableModelIds(keyType, consumerKeyId).has(modelId)) {
    return null;
  }

  const row = getDb().prepare(`
    SELECT id
    FROM models
    WHERE platform = 'openai-codex' AND model_id = ? AND enabled = 1
    LIMIT 1
  `).get(modelId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function buildModelListing(options: { excludeOpenAICodex?: boolean } = {}): ModelListing {
  const availableExpr = `
    (CASE WHEN m.enabled = 1 AND (
      EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
          AND (m.key_id IS NULL OR k.id = m.key_id)
      )
      OR (
        m.platform = 'openai-codex'
        AND EXISTS (
          SELECT 1 FROM codex_oauth_accounts c
          WHERE c.enabled = 1
            AND c.status IN ('healthy', 'unknown')
            AND (c.cooldown_until IS NULL OR c.cooldown_until <= datetime('now'))
        )
      )
    ) THEN 1 ELSE 0 END)`;
  const db = getDb();

  let allListed: NormalizedModel[];

  if (isUnifyEnabled()) {
    // Unify ON: one entry per logical model group. Pull per-row availability +
    // context keyed by db id, then aggregate over each group's members.
    type AvailRow = { id: number; platform: string; intelligence_rank: number; context_window: number | null; enabled: number; available: number; supports_tools: number };
    const rows = (db.prepare(`
      SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools,
             m.enabled AS enabled, ${availableExpr} AS available
      FROM models m
    `).all() as AvailRow[]).filter(row => !options.excludeOpenAICodex || row.platform !== 'openai-codex');
    const byId = new Map(rows.map(r => [r.id, r]));
    allListed = getModelGroups().flatMap(g => {
      const infos = g.members.map(m => byId.get(m.model_db_id)).filter(Boolean) as AvailRow[];
      if (infos.length === 0) return [];
      const ctxs = infos.map(i => i.context_window).filter((c): c is number => c != null);
      return [{
        id: g.canonicalId,
        name: g.groupLabel,
        ownedBy: 'freellmapi',
        available: infos.some(i => i.available === 1) ? 1 : 0,
        enabled: infos.some(i => i.enabled === 1) ? 1 : 0,
        contextWindow: ctxs.length ? Math.max(...ctxs) : null,
        intel: infos.length ? Math.min(...infos.map(i => i.intelligence_rank)) : Number.MAX_SAFE_INTEGER,
        platforms: [...new Set(infos.map(i => i.platform))],
        supportsTools: infos.some(i => i.supports_tools === 1),
      }];
    });
  } else {
    // Unify OFF: one entry per model_id (dedup picks the available, smartest
    // representative row).
    const models = db.prepare(`
      SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools
      FROM (
        SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools,
               m.enabled AS enabled,
               ${availableExpr} AS available,
               ROW_NUMBER() OVER (
                 PARTITION BY m.model_id
                 ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
               ) AS rn
        FROM models m
        ${options.excludeOpenAICodex ? "WHERE m.platform <> 'openai-codex'" : ''}
      )
      WHERE rn = 1
    `).all() as (ModelListRow & { intelligence_rank: number; id: number; supports_tools: number })[];
    allListed = models.map(m => ({
      id: m.model_id, name: m.display_name, ownedBy: m.platform,
      available: m.available, enabled: m.enabled, contextWindow: m.context_window,
      intel: m.intelligence_rank,
      platforms: [m.platform],
      supportsTools: m.supports_tools === 1,
    }));
  }

  // Stable order: usable first, then enabled, then smartest, then name.
  allListed.sort((a, b) =>
    (b.available - a.available) || (b.enabled - a.enabled) || (a.intel - b.intel) || a.name.localeCompare(b.name));

  const availableContextWindows = allListed
    .filter(m => m.available === 1 && m.contextWindow != null)
    .map(m => m.contextWindow as number);
  const autoContextWindow = availableContextWindows.length > 0
    ? Math.max(...availableContextWindows)
    : null;

  return { models: allListed, autoContextWindow };
}
