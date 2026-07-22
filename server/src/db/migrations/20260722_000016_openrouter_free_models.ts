import type { Db } from '../types.js';

type FreeModel = [
  platform: string,
  modelId: string,
  displayName: string,
  intelligenceRank: number,
  speedRank: number,
  sizeLabel: string,
  rpmLimit: number | null,
  rpdLimit: number | null,
  tpmLimit: number | null,
  tpdLimit: number | null,
  monthlyTokenBudget: string,
  contextWindow: number,
  enabled: number,
  supportsVision: number,
  supportsTools: number,
];

const FREE_MODELS: FreeModel[] = [
  [
    'openrouter',
    'openrouter/free',
    'OpenRouter Free Router',
    3,
    5,
    'Frontier',
    20,
    200,
    null,
    null,
    '~6M',
    200000,
    1,
    1,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'NVIDIA Nemotron 3 Ultra (free)',
    1,
    10,
    'Frontier',
    20,
    200,
    null,
    null,
    '~6M',
    1000000,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'NVIDIA Nemotron 3 Super (free)',
    2,
    8,
    'Frontier',
    20,
    200,
    null,
    null,
    '~6M',
    1000000,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'cohere/north-mini-code:free',
    'Cohere North Mini Code (free)',
    5,
    3,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    256000,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'poolside/laguna-xs-2.1:free',
    'Poolside Laguna XS 2.1 (free)',
    5,
    3,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    262144,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'NVIDIA Nemotron 3 Nano 30B A3B (free)',
    8,
    2,
    'Medium',
    20,
    200,
    null,
    null,
    '~6M',
    256000,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'NVIDIA Nemotron 3 Nano Omni (free)',
    7,
    6,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    256000,
    1,
    1,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-nano-9b-v2:free',
    'NVIDIA Nemotron Nano 9B V2 (free)',
    10,
    1,
    'Medium',
    20,
    200,
    null,
    null,
    '~6M',
    128000,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'openai/gpt-oss-20b:free',
    'OpenAI GPT-OSS 20B (free)',
    7,
    4,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    131072,
    1,
    0,
    1,
  ],
  [
    'openrouter',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'NVIDIA Nemotron Nano 12B V2 VL (free)',
    8,
    6,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    128000,
    1,
    1,
    1,
  ],
  [
    'openrouter',
    'google/gemma-4-26b-a4b-it:free',
    'Google Gemma 4 26B A4B (free)',
    4,
    5,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    262144,
    1,
    1,
    1,
  ],
  [
    'openrouter',
    'google/gemma-4-31b-it:free',
    'Google Gemma 4 31B (free)',
    3,
    7,
    'Large',
    20,
    200,
    null,
    null,
    '~6M',
    262144,
    1,
    1,
    1,
  ],
];

export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform,
      model_id,
      display_name,
      intelligence_rank,
      speed_rank,
      size_label,
      rpm_limit,
      rpd_limit,
      tpm_limit,
      tpd_limit,
      monthly_token_budget,
      context_window,
      enabled,
      supports_vision,
      supports_tools
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const apply = db.transaction(() => {
    for (const model of FREE_MODELS) {
      insertModel.run(...model);
    }

    const modelIds = FREE_MODELS.map((model) => model[1]);
    const placeholders = modelIds.map(() => '?').join(', ');

    const missingFallbackRows = db.prepare(`
      SELECT m.id
        FROM models m
        LEFT JOIN fallback_config f
          ON f.model_db_id = m.id
       WHERE m.platform = 'openrouter'
         AND m.model_id IN (${placeholders})
         AND f.id IS NULL
       ORDER BY m.intelligence_rank ASC, m.id ASC
    `).all(...modelIds) as Array<{ id: number }>;

    if (missingFallbackRows.length === 0) {
      return;
    }

    const maxPriorityRow = db.prepare(`
      SELECT COALESCE(MAX(priority), 0) AS max_priority
        FROM fallback_config
    `).get() as { max_priority: number };

    const insertFallback = db.prepare(`
      INSERT INTO fallback_config (
        model_db_id,
        priority,
        enabled
      )
      VALUES (?, ?, 1)
    `);

    for (let index = 0; index < missingFallbackRows.length; index += 1) {
      insertFallback.run(
        missingFallbackRows[index].id,
        maxPriorityRow.max_priority + index + 1,
      );
    }
  });

  apply();
}

export function down(db: Db): void {
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config
     WHERE model_db_id IN (
       SELECT id
         FROM models
        WHERE platform = 'openrouter'
          AND model_id = ?
     )
  `);

  const deleteModel = db.prepare(`
    DELETE FROM models
     WHERE platform = 'openrouter'
       AND model_id = ?
  `);

  const rollback = db.transaction(() => {
    for (const model of FREE_MODELS) {
      const modelId = model[1];

      deleteFallback.run(modelId);
      deleteModel.run(modelId);
    }
  });

  rollback();
}