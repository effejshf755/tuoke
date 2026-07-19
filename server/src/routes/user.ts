import { Router } from 'express';
import type { Request } from 'express';
import { getDb } from '../db/index.js';
import { getConsumerMonthlyUsage } from '../services/consumer-api-keys.js';

export const userRouter = Router();

userRouter.get('/usage', (req, res) => {
  const userId = (req as Request & { user: { userId: number } }).user.userId;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS total_requests,
           COALESCE(SUM(input_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(output_tokens), 0) AS completion_tokens,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
      FROM requests
     WHERE consumer_user_id = ?
  `).get(userId) as { total_requests: number; prompt_tokens: number; completion_tokens: number; total_tokens: number };
  const monthly = getConsumerMonthlyUsage(getDb(), userId);
  res.json({ ...row, monthly_used_tokens: monthly.usedTokens, monthly_token_limit: monthly.limit, monthly_remaining_tokens: Math.max(0, monthly.limit - monthly.usedTokens) });
});

userRouter.get('/models', (_req, res) => {
  const rows = getDb().prepare(`SELECT model_id, display_name, platform, context_window, enabled FROM models WHERE enabled = 1 ORDER BY intelligence_rank ASC, model_id ASC`).all();
  res.json({ models: [{ model_id: 'auto', display_name: 'Auto', platform: 'Tuoke API', context_window: null, enabled: 1 }, ...rows] });
});
