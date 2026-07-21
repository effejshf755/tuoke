import { Router } from 'express';
import { getSetting } from '../db/index.js';
export const publicPlatformRouter = Router();
publicPlatformRouter.get('/settings', (_req, res) => res.json({ platform_notice: getSetting('platform_notice') ?? '', registration_enabled: getSetting('registration_enabled') !== '0', maintenance_mode: getSetting('maintenance_mode') === '1', minimum_recharge_micro: Number(getSetting('minimum_recharge_micro') ?? 1_000_000), maximum_recharge_micro: Number(getSetting('maximum_recharge_micro') ?? 1_000_000_000_000), default_consumer_rpm: Number(getSetting('default_consumer_rpm') ?? 60) }));
