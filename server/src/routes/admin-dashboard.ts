import { Router } from 'express';
import { getDb } from '../db/index.js';
export const adminDashboardRouter = Router();
function since(range: string): string | null { const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 0; return days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ') : null; }
adminDashboardRouter.get('/summary', (req, res) => {
  const db = getDb(); const cutoff = since(typeof req.query.range === 'string' ? req.query.range : '30d'); const args = cutoff ? [cutoff] : [];
  const where = cutoff ? ' WHERE created_at >= ?' : '';
  const users = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN status = \'active\' THEN 1 ELSE 0 END) enabled FROM users').get() as any;
  const keys = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status = 'active' AND enabled = 1 AND (expires_at IS NULL OR expires_at > datetime('now')) THEN 1 ELSE 0 END) active FROM consumer_api_keys").get() as any;
  const stats = db.prepare(`SELECT COUNT(*) requests, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failures, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(billing_amount_micro),0) revenue FROM requests${where}`).get(...args) as any;
  const wallet = db.prepare('SELECT COALESCE(SUM(balance_micro),0) balance, COALESCE(SUM(reserved_balance_micro),0) reserved FROM users').get() as any;
  const recharge = db.prepare("SELECT COALESCE(SUM(amount_micro),0) total FROM recharge_orders WHERE status = 'paid'").get() as any;
  const models = db.prepare(`SELECT platform, model_id model, COUNT(*) requests, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(billing_amount_micro),0) revenue FROM requests${where} GROUP BY platform, model_id ORDER BY requests DESC LIMIT 10`).all(...args);
  const providers = db.prepare(`SELECT platform, COUNT(*) requests, ROUND(100.0 * SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) / COUNT(*), 1) success_rate FROM requests${where} GROUP BY platform ORDER BY requests DESC`).all(...args);
  const failures = db.prepare(`SELECT r.id, r.created_at created_at, u.email, r.model_id model, r.platform, r.status, substr(COALESCE(r.error,''),1,300) error FROM requests r LEFT JOIN users u ON u.id = r.consumer_user_id WHERE r.status='error'${cutoff ? ' AND r.created_at >= ?' : ''} ORDER BY r.id DESC LIMIT 20`).all(...args);
  res.json({ users, keys, stats: { ...stats, successRate: stats.requests ? Math.round(stats.success / stats.requests * 1000) / 10 : 0 }, wallet, recharge, models, providers, failures });
});
