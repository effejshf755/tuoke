import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { responsesRouter } from './routes/responses.js';
import { anthropicRouter } from './routes/anthropic.js';
import { fallbackRouter } from './routes/fallback.js';
import { profilesRouter } from './routes/profiles.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { mediaRouter } from './routes/media.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { premiumRouter } from './routes/premium.js';
import { cacheRouter } from './routes/cache.js';
import { authRouter } from './routes/auth.js';
import { docsRouter } from './routes/docs.js';
import { mcpRouter } from './routes/mcp.js';
import { consumerApiKeysRouter } from './routes/consumer-api-keys.js';
import { userRouter } from './routes/user.js';
import { userAnalyticsRouter } from './routes/user-analytics.js';
import { userWalletRouter } from './routes/user-wallet.js';
import { userRechargeRouter, adminRechargeRouter, alipayNotifyRouter } from './routes/recharge.js';
import { adminUsersRouter } from './routes/admin-users.js';
import { codexOauthRouter } from './routes/codex-oauth.js';
import { codexAuthRouter } from './routes/codex-auth.js';
import { adminBillingRouter } from './routes/admin-billing.js';
import { adminWalletRouter } from './routes/admin-wallet.js';
import { adminDashboardRouter } from './routes/admin-dashboard.js';
import { adminPlatformSettingsRouter } from './routes/admin-platform-settings.js';
import { requireAuth } from './middleware/requireAuth.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import { consumerQuota } from './middleware/consumerQuota.js';
import { createProxyRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { clientContextMiddleware } from './lib/client-context.js';
import type { Config } from './lib/config.js';
import { loadConfig } from './lib/config.js';
import { getSetting } from './db/index.js';
import { publicPlatformRouter } from './routes/public-platform.js';
import { adminResourcesRouter } from './routes/admin-resources.js';
import { notificationsRouter, adminNotificationsRouter } from './routes/notifications.js';
import { resourceUserRouter } from './routes/resource-user.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DASHBOARD_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

export function createApp(config?: Config) {
  const cfg = config ?? loadConfig();
  const app = express();
  const allowedCorsOrigins = new Set([
    ...DEFAULT_DASHBOARD_ORIGINS,
    ...cfg.dashboardOrigins,
  ]);

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
  }));
  // 10mb: code agents (OpenCode, AionUI, Qwen Code) ship very large system
  // prompts + tool schemas + repo context; 1mb cut their sessions off
  // mid-conversation with an opaque 413. (#200)
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Caller identity (IP + User-Agent) for request analytics, carried in
  // AsyncLocalStorage so logRequest() can read it from any depth.
  app.use(clientContextMiddleware);

  // Dashboard auth (#35): /api/auth/{status,setup,login} bootstrap without a
  // session; everything else under /api/* requires a logged-in dashboard user.
  // The /v1 proxy keeps its own unified-API-key auth and is NOT gated here.
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicPlatformRouter);
  app.use('/api/payment/alipay/notify', alipayNotifyRouter);

  // API routes — all admin endpoints sit behind requireAuth.
  app.use('/api/keys', requireAuth, requireAdmin, keysRouter);
  app.use('/api/models', requireAuth, requireAdmin, modelsRouter);
  app.use('/api/profiles', requireAuth, requireAdmin, profilesRouter);
  app.use('/api/fallback', requireAuth, fallbackRouter);
  app.use('/api/embeddings', requireAuth, requireAdmin, embeddingsRouter);
  app.use('/api/media', requireAuth, requireAdmin, mediaRouter);
  app.use('/api/analytics', requireAuth, requireAdmin, analyticsRouter);
  app.use('/api/health', requireAuth, requireAdmin, healthRouter);
  app.use('/api/settings', requireAuth, requireAdmin, settingsRouter);
  app.use('/api/premium', requireAuth, requireAdmin, premiumRouter);
  app.use('/api/cache', requireAuth, requireAdmin, cacheRouter);
  app.use('/api/consumer-keys', requireAuth, consumerApiKeysRouter);
  app.use('/api/user/wallet', requireAuth, userWalletRouter);
  app.use('/api/user/recharge', requireAuth, userRechargeRouter);
  app.use('/api/user/notifications', requireAuth, notificationsRouter);
  app.use('/api/user', requireAuth, userRouter);
  app.use('/api/user/analytics', requireAuth, userAnalyticsRouter);
  app.use('/api/admin/users', requireAuth, requireAdmin, adminUsersRouter);
  app.use('/api/admin/billing', requireAuth, requireAdmin, adminBillingRouter);
  app.use('/api/admin/wallet', requireAuth, requireAdmin, adminWalletRouter);
  app.use('/api/admin/dashboard', requireAuth, requireAdmin, adminDashboardRouter);
  app.use('/api/admin/recharge', requireAuth, requireAdmin, adminRechargeRouter);
  app.use('/api/admin/settings', requireAuth, requireAdmin, adminPlatformSettingsRouter);
  app.use('/api/admin/codex', requireAuth, requireAdmin, codexOauthRouter);
  app.use('/api/admin/resources', requireAuth, requireAdmin, adminResourcesRouter);
  app.use('/api/admin/notifications', requireAuth, requireAdmin, adminNotificationsRouter);
  app.use('/api/resources', requireAuth, resourceUserRouter);
  app.use('/api/admin/codex-auth', codexAuthRouter);

  // Static, unauthenticated API reference: GET /v1/docs (viewer) and
  // GET /v1/openapi.json (spec). Mounted before the rate limiter so the docs
  // are always reachable and don't draw down a caller's request budget. It only
  // owns those two paths; everything else falls through to the routers below.
  app.use('/v1', docsRouter);

  // OpenAI-compatible proxy. Per-IP rate limiting (#35 item #6) runs first so
  // it throttles unauthenticated brute-force / flood attempts before any
  // routing work. Tune via PROXY_RATE_LIMIT_RPM; 0 disables it.
  app.use('/v1', (req, res, next) => {
    if (getSetting('maintenance_mode') === '1') { res.status(503).json({ error: { message: 'Service is under maintenance', type: 'maintenance_mode' } }); return; }
    next();
  }, consumerQuota, createProxyRateLimiter(cfg.proxyRateLimitRpm));
  // Anthropic-compatible Messages API (`POST /v1/messages`, `/count_tokens`) for
  // Claude Code and anything else speaking the Anthropic SDK. Mounted BEFORE the
  // OpenAI router so it can content-negotiate `GET /v1/models` (Anthropic shape
  // when the caller sends `anthropic-version`, else it falls through). All other
  // paths it doesn't own fall through to the OpenAI router untouched.
  app.use('/v1', anthropicRouter);
  app.use('/v1', proxyRouter);
  // OpenAI Responses API shim (Codex CLI requires wire_api="responses"; see #96)
  app.use('/v1', responsesRouter);

  // MCP server (Model Context Protocol over stateless Streamable HTTP):
  // gateway introspection tools for MCP-speaking agents. Unified-key auth,
  // like /v1 — NOT behind the dashboard session gate. Same per-IP limiter as
  // /v1 (its own bucket): both surfaces guard the same unified key, so an
  // unauthenticated brute-force must not get a free throttle-less oracle here.
  app.use('/mcp', createProxyRateLimiter(cfg.proxyRateLimitRpm));
  app.use('/mcp', mcpRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler). CLIENT_DIST lets
  // embedders relocate the built dashboard (e.g. the desktop app ships it in
  // extraResources, where the __dirname-relative path can't reach).
  // Set serveStaticAssets: false in Config to skip static serving entirely
  // (e.g. in runtimes that serve assets through a different mechanism).
  if (cfg.serveStaticAssets) {
    const clientDist = cfg.clientDist
      ? path.resolve(cfg.clientDist)
      : path.resolve(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    // SPA fallback — serve index.html for non-API routes
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
        next();
        return;
      }
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
