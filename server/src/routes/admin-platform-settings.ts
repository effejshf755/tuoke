import { Router } from 'express';
import { getSetting, setSetting } from '../db/index.js';
import { defaults } from '../lib/platform-settings.js';
import { z } from 'zod';
export const adminPlatformSettingsRouter = Router();
const schema = z.object({ default_consumer_rpm: z.number().int().min(0).max(100000), registration_enabled: z.boolean(), new_user_bonus_micro: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), minimum_recharge_micro: z.number().int().positive(), maximum_recharge_micro: z.number().int().positive(), platform_notice: z.string().max(2000), maintenance_mode: z.boolean() });
function read() { return Object.fromEntries(Object.keys(defaults).map((key) => { const value = getSetting(key); const d = defaults[key as keyof typeof defaults]; return [key, typeof d === 'boolean' ? value === '1' : typeof d === 'number' ? Number(value ?? d) : value ?? d]; })); }
adminPlatformSettingsRouter.get('/', (_req, res) => res.json({ settings: read() }));
adminPlatformSettingsRouter.put('/', (req, res) => { const p = schema.safeParse(req.body); if (!p.success || p.data.minimum_recharge_micro > p.data.maximum_recharge_micro) { res.status(400).json({ error: { message: 'Invalid platform settings', type: 'validation_error' } }); return; } for (const [k,v] of Object.entries(p.data)) setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); res.json({ settings: read() }); });
