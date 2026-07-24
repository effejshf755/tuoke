import { Router } from 'express';
import type { Request } from 'express';
import { getDb } from '../db/index.js';

export const userAnalyticsRouter = Router();

function userId(req: Request): number { return (req as Request & { user: { userId: number } }).user.userId; }
function since(range: string): string {
  const days = range === '24h' ? 1 : range === '30d' ? 30 : range === '90d' ? 90 : 7;
  return new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
}
const scope = `(r.consumer_user_id = ? OR (r.consumer_user_id IS NULL AND r.consumer_api_key_id IN (SELECT id FROM consumer_api_keys WHERE user_id = ?)))`;
function params(req: Request) { const id = userId(req); return { id, since: since(String(req.query.range ?? '7d')) }; }
function pct(success: number, total: number) { return total ? Math.round(success * 1000 / total) / 10 : 0; }

userAnalyticsRouter.get('/summary', (req, res) => {
  const { id, since: from } = params(req); const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(AVG(latency_ms),0) avg_latency, AVG(ttfb_ms) avg_ttfb, MIN(created_at) first_at, SUM(CASE WHEN request_type='embedding' THEN 1 ELSE 0 END) embeddings, SUM(CASE WHEN request_type!='embedding' THEN 1 ELSE 0 END) chats, SUM(CASE WHEN requested_model IS NOT NULL AND requested_model!='auto' THEN 1 ELSE 0 END) pinned FROM requests r WHERE ${scope} AND r.created_at>=?`).get(id, id, from) as any;
  const latencies = db.prepare(`SELECT latency_ms FROM requests r WHERE ${scope} AND r.created_at>=? AND latency_ms IS NOT NULL ORDER BY latency_ms`).all(id, id, from) as Array<{ latency_ms: number }>;
  const percentile = (p: number) => latencies.length ? latencies[Math.floor((latencies.length - 1) * p)].latency_ms : null;
  res.json({ totalRequests: row.total, successRate: pct(row.success, row.total), totalInputTokens: row.input, totalOutputTokens: row.output, avgLatencyMs: Math.round(row.avg_latency), p50LatencyMs: percentile(.5), p95LatencyMs: percentile(.95), avgTtfbMs: row.avg_ttfb == null ? null : Math.round(row.avg_ttfb), requestTypeCounts: { chat: row.chats, embedding: row.embeddings }, estimatedCostSavings: 0, pinnedRequests: row.pinned, pinHonoredRequests: 0, firstRequestAt: row.first_at, lifetimeTotalRequests: row.total });
});

userAnalyticsRouter.get('/by-platform', (req, res) => {
  const { id, since: from } = params(req); const db = getDb();
  const rows = db.prepare(`SELECT platform, COUNT(*) requests, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors, AVG(latency_ms) avg_latency, AVG(ttfb_ms) avg_ttfb, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output FROM requests r WHERE ${scope} AND created_at>=? GROUP BY platform ORDER BY requests DESC`).all(id, id, from) as any[];
  res.json(rows.map(r => ({ platform: r.platform, requests: r.requests, successRate: pct(r.success, r.requests), avgLatencyMs: Math.round(r.avg_latency ?? 0), p95LatencyMs: null, avgTtfbMs: r.avg_ttfb == null ? null : Math.round(r.avg_ttfb), errorCount: r.errors, avgTokensPerSecond: null, totalInputTokens: r.input, totalOutputTokens: r.output })));
});

userAnalyticsRouter.get('/timeline', (req, res) => {
  const { id, since: from } = params(req); const hourly = String(req.query.range ?? '7d') === '24h'; const fmt = hourly ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';
  const rows = getDb().prepare(`SELECT strftime('${fmt}',created_at) timestamp, COUNT(*) requests, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success_count, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) failure_count, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens FROM requests r WHERE ${scope} AND created_at>=? GROUP BY timestamp ORDER BY timestamp`).all(id, id, from) as any[];
  res.json(rows.map(r => ({ timestamp: r.timestamp, requests: r.requests, successCount: r.success_count, failureCount: r.failure_count, inputTokens: r.input_tokens, outputTokens: r.output_tokens })));
});

userAnalyticsRouter.get('/by-model', (req, res) => {
  const { id, since: from } = params(req); const rows = getDb().prepare(`SELECT r.platform,r.model_id,COALESCE(m.display_name,r.model_id) display_name,COUNT(*) requests,SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) success,AVG(r.latency_ms) avg_latency,COALESCE(SUM(r.input_tokens),0) input,COALESCE(SUM(r.output_tokens),0) output,SUM(CASE WHEN r.requested_model=r.model_id THEN 1 ELSE 0 END) pinned FROM requests r LEFT JOIN models m ON m.platform=r.platform AND m.model_id=r.model_id WHERE ${scope} AND r.created_at>=? GROUP BY r.platform,r.model_id ORDER BY requests DESC`).all(id, id, from) as any[];
  res.json(rows.map(r => ({ platform:r.platform,modelId:r.model_id,displayName:r.display_name,requests:r.requests,successRate:pct(r.success,r.requests),avgLatencyMs:Math.round(r.avg_latency??0),totalInputTokens:r.input,totalOutputTokens:r.output,pinnedRequests:r.pinned,estimatedCost:0 })));
});

userAnalyticsRouter.get('/by-key', (req, res) => {
  const { id, since: from } = params(req); const rows = getDb().prepare(`SELECT r.consumer_api_key_id key_id,k.name label,COUNT(*) requests,SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) success,AVG(r.latency_ms) avg_latency,COALESCE(SUM(r.input_tokens),0) input,COALESCE(SUM(r.output_tokens),0) output FROM requests r LEFT JOIN consumer_api_keys k ON k.id=r.consumer_api_key_id WHERE ${scope} AND r.created_at>=? AND r.consumer_api_key_id IS NOT NULL GROUP BY r.consumer_api_key_id ORDER BY requests DESC`).all(id,id,from) as any[];
  res.json(rows.map(r => ({ keyId:r.key_id,label:r.label,platform:null,requests:r.requests,successRate:pct(r.success,r.requests),avgLatencyMs:Math.round(r.avg_latency??0),totalInputTokens:r.input,totalOutputTokens:r.output })));
});

userAnalyticsRouter.get('/errors', (req, res) => { const {id,since:from}=params(req); const rows=getDb().prepare(`SELECT id,platform,model_id,error,latency_ms,created_at FROM requests r WHERE ${scope} AND status='error' AND created_at>=? ORDER BY created_at DESC LIMIT 50`).all(id,id,from) as any[]; res.json(rows.map(r=>({id:r.id,platform:r.platform,modelId:r.model_id,error:r.error,latencyMs:r.latency_ms,createdAt:r.created_at}))); });
userAnalyticsRouter.get('/error-distribution', (req, res) => { const {id,since:from}=params(req); const rows=getDb().prepare(`SELECT platform,COUNT(*) count FROM requests r WHERE ${scope} AND status='error' AND created_at>=? GROUP BY platform ORDER BY count DESC`).all(id,id,from) as any[]; res.json({byCategory:[],byPlatform:rows,detailed:[]}); });
userAnalyticsRouter.get('/requests', (req, res) => { const {id,since:from}=params(req); const limit=Math.min(Number(req.query.limit)||100,500); const db=getDb(); const total=(db.prepare(`SELECT COUNT(*) c FROM requests r WHERE ${scope} AND created_at>=?`).get(id,id,from) as any).c; const rows=db.prepare(`SELECT id,platform,model_id,requested_model,request_type,status,input_tokens,output_tokens,latency_ms,error,client_ip,client_user_agent,strftime('%Y-%m-%dT%H:%M:%SZ',created_at) created_at_iso FROM requests r WHERE ${scope} AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(id,id,from,limit) as any[]; res.json({total,rows:rows.map(r=>({id:r.id,platform:r.platform,modelId:r.model_id,requestedModel:r.requested_model,requestType:r.request_type,status:r.status,inputTokens:r.input_tokens,outputTokens:r.output_tokens,latencyMs:r.latency_ms,error:r.error,clientIp:r.client_ip,clientUserAgent:r.client_user_agent,createdAt:r.created_at_iso}))}); });
