import { getSetting, setSetting } from '../db/index.js';

export const defaults = { default_consumer_rpm: 60, registration_enabled: true, new_user_bonus_micro: 0, minimum_recharge_micro: 1_000_000, maximum_recharge_micro: 1_000_000_000_000, platform_notice: '', maintenance_mode: false } as const;
export function settingNumber(key: keyof typeof defaults): number { const n = Number(getSetting(key) ?? defaults[key]); return Number.isFinite(n) ? n : Number(defaults[key]); }
export function settingBool(key: keyof typeof defaults): boolean { return (getSetting(key) ?? (defaults[key] ? '1' : '0')) === '1'; }
export function settingString(key: keyof typeof defaults): string { return getSetting(key) ?? String(defaults[key]); }
