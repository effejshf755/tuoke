import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { validateConsumerApiKey, getConsumerMonthlyUsage } from '../services/consumer-api-keys.js';

export function consumerQuota(req: Request, res: Response, next: NextFunction): void {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  const header = req.headers['x-api-key'];
  const token = bearer || (Array.isArray(header) ? header[0] : header)?.trim();
  if (!token?.startsWith('tuoke-')) { next(); return; }
  const key = validateConsumerApiKey(getDb(), token);
  if (!key) { next(); return; }
  const usage = getConsumerMonthlyUsage(getDb(), key.userId);
  if (usage.usedTokens >= usage.limit) {
    res.status(429).json({ error: { message: 'Monthly token quota exceeded', type: 'quota_exceeded' } });
    return;
  }
  next();
}
