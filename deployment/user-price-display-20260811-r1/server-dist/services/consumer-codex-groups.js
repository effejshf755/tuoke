function pricePerMillion(priceMicroPerMillion, multiplierMilli, cachedMultiplierMilli = 1_000) {
    const scaled = Math.max(0, Number(priceMicroPerMillion))
        * Math.max(0, multiplierMilli)
        * Math.max(0, cachedMultiplierMilli)
        / 1_000
        / 1_000
        / 1_000_000;
    if (scaled === 0)
        return 0;
    return Number(scaled.toPrecision(12));
}
/**
 * Groups offered while creating a shared Codex key must already have at least
 * one enabled, model-compatible upstream bound to them. Runtime health,
 * cooldown, and remaining quota are intentionally handled by the scheduler:
 * a temporary outage must not make an existing group disappear from the key
 * creation form.
 */
export function listConsumerCodexGroups(db) {
    const boundRows = db.prepare(`
    WITH bound_upstreams AS (
      SELECT DISTINCT
        g.id,
        g.name,
        g.description,
        g.multiplier_milli,
        g.max_concurrency,
        a.codex_group_id AS group_id,
        'oauth:' || a.id AS source_key,
        'oauth' AS source_type,
        am.model_id AS model_id,
        NULL AS upstream_model_id,
        NULL AS relay_protocol
      FROM codex_oauth_accounts a
      JOIN codex_groups g
        ON g.id = a.codex_group_id
       AND g.enabled = 1
      JOIN codex_oauth_account_models am
        ON am.account_id = a.id
       AND am.enabled = 1
      JOIN codex_group_models gm
        ON gm.group_id = a.codex_group_id
       AND gm.model_id = am.model_id
      JOIN models m
        ON m.platform = 'openai-codex'
       AND m.model_id = am.model_id
       AND m.enabled = 1
      JOIN model_billing_rules b
        ON b.platform = 'openai-codex'
       AND b.model_id = am.model_id
       AND b.billing_enabled = 1
      WHERE a.enabled = 1
        AND a.deleted_at IS NULL
        AND a.resource_scope = 'codex_pool'
        AND am.model_id <> 'codex'

      UNION

      SELECT DISTINCT
        g.id,
        g.name,
        g.description,
        g.multiplier_milli,
        g.max_concurrency,
        s.codex_group_id AS group_id,
        'relay:' || s.id AS source_key,
        'relay' AS source_type,
        sm.public_model_id AS model_id,
        sm.upstream_model_id AS upstream_model_id,
        s.protocol AS relay_protocol
      FROM codex_relay_sources s
      JOIN codex_groups g
        ON g.id = s.codex_group_id
       AND g.enabled = 1
      JOIN codex_relay_source_models sm
        ON sm.source_id = s.id
       AND sm.enabled = 1
      JOIN codex_group_models gm
        ON gm.group_id = s.codex_group_id
       AND gm.model_id = sm.public_model_id
      JOIN models m
        ON m.platform = 'openai-codex'
       AND m.model_id = sm.public_model_id
       AND m.enabled = 1
      JOIN model_billing_rules b
        ON b.platform = 'openai-codex'
       AND b.model_id = sm.public_model_id
       AND b.billing_enabled = 1
      WHERE s.enabled = 1
        AND EXISTS (
          SELECT 1
          FROM codex_relay_source_keys source_key
          JOIN api_keys source_api_key
            ON source_api_key.id = source_key.api_key_id
           AND source_api_key.role = 'codex_relay'
           AND source_api_key.platform = 'custom'
           AND source_api_key.enabled = 1
          WHERE source_key.source_id = s.id
            AND source_key.enabled = 1
        )
        AND sm.public_model_id <> 'codex'
    )
    SELECT
      id,
      name,
      description,
      multiplier_milli,
      max_concurrency,
      group_id,
      source_key,
      source_type,
      model_id,
      upstream_model_id,
      relay_protocol
    FROM bound_upstreams
    ORDER BY name ASC, id ASC, model_id ASC, source_key ASC
  `).all();
    const groupedRows = new Map();
    for (const row of boundRows) {
        const group = groupedRows.get(row.id) ?? {
            id: Number(row.id),
            name: row.name,
            description: row.description,
            multiplier_milli: Number(row.multiplier_milli),
            max_concurrency: row.max_concurrency === null ? null : Number(row.max_concurrency),
            modelIds: new Set(),
            oauthAccountIds: new Set(),
            relaySourceIds: new Set(),
            upstreamIds: new Set(),
        };
        group.modelIds.add(row.model_id);
        if (row.source_type === 'oauth')
            group.oauthAccountIds.add(row.source_key);
        else
            group.relaySourceIds.add(row.source_key);
        group.upstreamIds.add(row.source_key);
        groupedRows.set(row.id, group);
    }
    const rows = [...groupedRows.values()]
        .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
    const pricingRows = db.prepare(`
    SELECT
      gm.group_id,
      gm.model_id,
      COALESCE(
        gm.input_price_micro_per_million_override,
        b.input_price_micro_per_million
      ) AS input_price_micro_per_million,
      COALESCE(
        gm.output_price_micro_per_million_override,
        b.output_price_micro_per_million
      ) AS output_price_micro_per_million,
      COALESCE(gm.multiplier_milli_override, b.multiplier_milli)
        AS multiplier_milli,
      COALESCE(
        gm.cached_input_multiplier_milli_override,
        b.cached_input_multiplier_milli,
        1000
      ) AS cached_input_multiplier_milli
    FROM codex_group_models gm
    JOIN codex_groups g
      ON g.id = gm.group_id
     AND g.enabled = 1
    JOIN model_billing_rules b
      ON b.platform = 'openai-codex'
     AND b.model_id = gm.model_id
     AND b.billing_enabled = 1
  `).all();
    return rows.map((row) => {
        const modelIds = [...row.modelIds].sort();
        const availableModels = new Set(modelIds);
        const modelPricing = pricingRows
            .filter((pricing) => pricing.group_id === row.id && availableModels.has(pricing.model_id))
            .map((pricing) => {
            const multiplierMilli = Math.max(0, Number(pricing.multiplier_milli));
            return {
                modelId: pricing.model_id,
                inputPricePerMillion: pricePerMillion(pricing.input_price_micro_per_million, multiplierMilli),
                outputPricePerMillion: pricePerMillion(pricing.output_price_micro_per_million, multiplierMilli),
                cachedInputPricePerMillion: pricePerMillion(pricing.input_price_micro_per_million, multiplierMilli, pricing.cached_input_multiplier_milli),
                effectiveMultiplier: Number((multiplierMilli / 1_000).toFixed(3)),
            };
        })
            .sort((left, right) => left.modelId.localeCompare(right.modelId));
        return {
            id: Number(row.id),
            name: row.name,
            description: row.description,
            multiplier: Number(row.multiplier_milli) / 1000,
            maxConcurrency: row.max_concurrency === null ? null : Number(row.max_concurrency),
            modelIds,
            oauthAccountCount: row.oauthAccountIds.size,
            relaySourceCount: row.relaySourceIds.size,
            upstreamCount: row.upstreamIds.size,
            modelPricing,
        };
    });
}
/**
 * Keep every administratively enabled group visible in the consumer form.
 * Empty or incompletely configured groups are exposed as non-selectable so
 * consumers cannot create a key that cannot route any request.
 */
export function listConsumerCodexGroupOptions(db) {
    const selectableGroups = new Map(listConsumerCodexGroups(db).map((group) => [group.id, group]));
    const rows = db.prepare(`
    SELECT id, name, multiplier_milli, max_concurrency
    FROM codex_groups
    WHERE enabled = 1
    ORDER BY name ASC, id ASC
  `).all();
    return rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        selectable: selectableGroups.has(Number(row.id)),
        multiplier: Number(row.multiplier_milli) / 1_000,
        maxConcurrency: row.max_concurrency === null ? null : Number(row.max_concurrency),
        modelPricing: selectableGroups.get(Number(row.id))?.modelPricing ?? [],
    }));
}
export function isConsumerCodexGroupSelectable(db, groupId) {
    return listConsumerCodexGroups(db).some((group) => group.id === groupId);
}
//# sourceMappingURL=consumer-codex-groups.js.map