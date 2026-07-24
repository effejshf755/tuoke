import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import {
  isCatalogManagedModel,
  recordCatalogModelTombstone,
  getModelMetadata,
  upsertModelOverrides,
  upsertModelMetadata,
  type ModelMetadata,
  type ModelOverridePatch,
} from '../services/model-state.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { checkAllModelsHealth, checkModelHealth, getModelHealthMap } from '../services/model-health.js';

export const modelsRouter = Router();

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const modelMetadataSchema = z.object({
  manufacturer: z.string().max(120).optional(),
  upstreamPlatform: z.string().max(120).optional(),
  modelType: z.string().max(120).optional(),
  billingType: z.string().max(120).optional(),
  apiType: z.string().max(120).optional(),
  sourceMethod: z.string().max(120).optional(),
  description: z.string().max(20_000).optional(),
}).partial();

const openRouterImportSchema = z.object({
  models: z.array(z.object({
    modelId: z.string().min(1).max(300),
    name: z.string().min(1).max(300).optional(),
    contextLength: z.number().int().positive().nullable().optional(),
    description: z.string().max(20_000).optional(),
    metadata: modelMetadataSchema.optional(),
    pricing: z.object({ prompt: z.string(), completion: z.string() }).optional(),
  })).min(1).max(500),
}).strict();

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  description?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { modality?: unknown; input_modalities?: unknown };
};

function inferManufacturer(modelId: string): string {
  const value = modelId.toLowerCase();
  if (value.includes('deepseek')) return 'DeepSeek';
  if (value.includes('qwen')) return 'Alibaba Qwen';
  if (value.includes('llama')) return 'Meta Llama';
  if (value.includes('gpt')) return 'OpenAI';
  if (value.includes('claude')) return 'Anthropic';
  if (value.includes('gemma')) return 'Google';
  if (value.includes('mistral')) return 'Mistral';
  const [namespace] = modelId.split('/');
  return namespace ? namespace : '未知厂家';
}

function inferModelType(model: OpenRouterModel): string {
  const inputModalities = Array.isArray(model.architecture?.input_modalities)
    ? model.architecture.input_modalities.map((value) => String(value).toLowerCase())
    : [];
  const modality = typeof model.architecture?.modality === 'string' ? model.architecture.modality.toLowerCase() : '';
  return inputModalities.some((value) => ['image', 'audio', 'video'].includes(value)) || modality.includes('multimodal')
    ? '多模态'
    : '文本对话';
}

function openRouterMetadata(model: OpenRouterModel, modelId: string): ModelMetadata {
  return {
    manufacturer: inferManufacturer(modelId),
    upstreamPlatform: 'OpenRouter',
    modelType: inferModelType(model),
    billingType: '免费模型',
    apiType: 'OpenAI 兼容接口',
    sourceMethod: 'OpenRouter 模型目录',
    description: typeof model.description === 'string' ? model.description : '',
  };
}

function isFreeOpenRouterModel(model: OpenRouterModel): boolean {
  const id = typeof model.id === 'string' ? model.id : '';
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  return id.includes(':free') || (Number.isFinite(prompt) && prompt === 0 && Number.isFinite(completion) && completion === 0);
}

modelsRouter.get('/discover/openrouter-free', async (_req: Request, res: Response) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) {
      res.status(502).json({ error: { message: `OpenRouter models request failed (${response.status})` } });
      return;
    }
    const payload = await response.json() as { data?: OpenRouterModel[] };
    const existingRows = getDb().prepare("SELECT model_id FROM models WHERE platform = 'openrouter'").all() as { model_id: string }[];
    const existing = new Set(existingRows.map((row) => row.model_id));
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .filter(isFreeOpenRouterModel)
      .map((model) => ({
        modelId: typeof model.id === 'string' ? model.id : '',
        name: typeof model.name === 'string' ? model.name : (typeof model.id === 'string' ? model.id : ''),
        contextLength: Number.isFinite(Number(model.context_length)) ? Number(model.context_length) : null,
        description: typeof model.description === 'string' ? model.description : '',
        pricing: {
          prompt: String(model.pricing?.prompt ?? '0'),
          completion: String(model.pricing?.completion ?? '0'),
        },
        metadata: typeof model.id === 'string' ? openRouterMetadata(model, model.id) : {},
        free: true,
      }))
      .filter((model) => model.modelId.length > 0)
      .filter((model) => !existing.has(model.modelId))
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
    res.json({ source: OPENROUTER_MODELS_URL, count: models.length, models });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'OpenRouter models request timed out' : 'Unable to fetch OpenRouter models';
    res.status(502).json({ error: { message } });
  } finally {
    clearTimeout(timeout);
  }
});

modelsRouter.post('/import/openrouter-free', (req: Request, res: Response) => {
  const parsed = openRouterImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: '请选择至少一个有效的 OpenRouter 免费模型' } });
    return;
  }
  const db = getDb();
  const result = db.transaction(() => {
    let added = 0;
    let skipped = 0;
    const find = db.prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = ?");
    const insertModel = db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window, enabled) VALUES ('openrouter', ?, ?, 999, 999, ?, 1)`);
    const insertBilling = db.prepare(`INSERT OR IGNORE INTO model_billing_rules (platform, model_id, input_price_micro_per_million, output_price_micro_per_million, multiplier_milli, billing_enabled) VALUES ('openrouter', ?, 0, 0, 1000, 1)`);
    for (const candidate of parsed.data.models) {
      if (find.get(candidate.modelId)) { skipped += 1; continue; }
      insertModel.run(candidate.modelId, candidate.name ?? candidate.modelId, candidate.contextLength ?? null);
      insertBilling.run(candidate.modelId);
      upsertModelMetadata(db, 'openrouter', candidate.modelId, {
        manufacturer: candidate.metadata?.manufacturer ?? inferManufacturer(candidate.modelId),
        upstreamPlatform: candidate.metadata?.upstreamPlatform ?? 'OpenRouter',
        modelType: candidate.metadata?.modelType ?? '文本对话',
        billingType: candidate.metadata?.billingType ?? '免费模型',
        apiType: candidate.metadata?.apiType ?? 'OpenAI 兼容接口',
        sourceMethod: candidate.metadata?.sourceMethod ?? 'OpenRouter 模型目录',
        description: candidate.metadata?.description ?? candidate.description ?? '',
      });
      added += 1;
    }
    return { added, skipped };
  })();
  res.json({ success: true, ...result });
});

modelsRouter.post('/:id/health-check', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  try {
    res.json({ id, health: await checkModelHealth(id) });
  } catch (error: any) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    res.status(status).json({ error: { message: error instanceof Error ? error.message : 'Model health check failed' } });
  }
});

modelsRouter.post('/health-check-all', async (_req: Request, res: Response) => {
  try {
    res.json(await checkAllModelsHealth(2));
  } catch (error) {
    res.status(500).json({ error: { message: error instanceof Error ? error.message : 'All model health checks failed' } });
  }
});

const modelUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  intelligenceRank: z.number().int().min(1).max(1000).optional(),
  speedRank: z.number().int().min(1).max(1000).optional(),
  sizeLabel: z.string().min(1).max(40).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  monthlyTokenBudget: z.string().max(80).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  fallbackEnabled: z.boolean().optional(),
  metadata: modelMetadataSchema.optional(),
}).strict();

const MODEL_FIELD_COLUMNS: Record<keyof ModelOverridePatch | 'enabled', string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
  enabled: 'enabled',
};

type ModelRow = {
  id: number;
  platform: string;
  model_id: string;
  key_id: number | null;
};

function dbValue(key: keyof typeof MODEL_FIELD_COLUMNS, value: unknown): unknown {
  if (key === 'enabled' || key === 'supportsVision' || key === 'supportsTools') return value ? 1 : 0;
  return value;
}

function fetchModelRow(id: number): ModelRow | undefined {
  return getDb()
    .prepare('SELECT id, platform, model_id, key_id FROM models WHERE id = ?')
    .get(id) as ModelRow | undefined;
}

modelsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT id, key_id FROM models WHERE id = ? AND platform = 'custom'").get(id) as { id: number; key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare("DELETE FROM models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  res.json({ success: true });
});

modelsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const parsed = modelUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const { metadata, ...modelFields } = parsed.data;
  const modelPatch: Partial<typeof modelFields> = { ...modelFields };
  delete modelPatch.fallbackEnabled;
  const modelKeys = Object.keys(modelPatch) as Array<keyof typeof modelPatch>;
  if (modelKeys.length === 0 && parsed.data.fallbackEnabled === undefined && !metadata) {
    res.status(400).json({ error: { message: 'No model fields provided' } });
    return;
  }

  const applyUpdate = db.transaction(() => {
    if (modelKeys.length > 0) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const key of modelKeys) {
        assignments.push(`${MODEL_FIELD_COLUMNS[key as keyof typeof MODEL_FIELD_COLUMNS]} = ?`);
        values.push(dbValue(key as keyof typeof MODEL_FIELD_COLUMNS, modelPatch[key]));
      }
      values.push(id);
      db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      if (isCatalogManagedModel(row)) {
        const overridePatch: ModelOverridePatch = {};
        for (const key of [
          'displayName', 'intelligenceRank', 'speedRank', 'sizeLabel',
          'rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit',
          'monthlyTokenBudget', 'contextWindow', 'supportsVision', 'supportsTools',
        ] as const) {
          if (Object.prototype.hasOwnProperty.call(modelPatch, key)) {
            overridePatch[key] = modelPatch[key] as never;
          }
        }
        upsertModelOverrides(db, row.platform, row.model_id, overridePatch);
      }
    }

    if (parsed.data.fallbackEnabled !== undefined) {
      const next = parsed.data.fallbackEnabled ? 1 : 0;
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?')
        .run(next, id);
      const activeProfileId = getActiveProfileId(db);
      if (activeProfileId != null) {
        db.prepare('UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id = ?')
          .run(next, activeProfileId, id);
      }
    }

    if (metadata) {
      upsertModelMetadata(db, row.platform, row.model_id, metadata);
    }
  });
  applyUpdate();

  res.json({ success: true, id });
});

modelsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    if (isCatalogManagedModel(row)) {
      recordCatalogModelTombstone(db, 'chat', row.platform, row.model_id);
    }
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
    if (row.platform === 'custom') deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();

  res.json({ success: true, tombstoned: isCatalogManagedModel(row) });
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const activeProfileId = getActiveProfileId(db);
  const models = activeProfileId == null ? db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[] : db.prepare(`
    SELECT m.*, COALESCE(pm.priority, fc.priority) AS priority,
           COALESCE(pm.enabled, fc.enabled) AS fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(pm.priority, fc.priority, m.intelligence_rank) ASC
  `).all(activeProfileId) as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    upstreamModelId: m.upstream_model_id ?? null,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    source: m.platform === 'custom' || m.key_id != null ? 'custom' : 'catalog',
    metadata: getModelMetadata(db, m.platform, m.model_id),
    keyId: m.key_id ?? null,
    keyLabel: m.key_label ?? null,
    hasOverrides: Boolean(m.has_overrides),
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
    health: getModelHealthMap(db)[`${m.platform}:${m.model_id}`] ?? null,
  }));

  res.json(result);
});
