import express, { type Express } from 'express';
import { describe, expect, it } from 'vitest';
import { clientContextMiddleware, setConsumerIdentity } from '../../lib/client-context.js';
import { createProxyRateLimiter } from '../../middleware/rateLimit.js';

function createLimiterApp(limit = 2): Express {
  const app = express();
  app.use(clientContextMiddleware);
  app.use((req, _res, next) => {
    const keyId = Number(req.headers['x-test-key-id']);
    if (Number.isSafeInteger(keyId) && keyId > 0) setConsumerIdentity(1, keyId, 'codex_pool');
    next();
  });
  app.use(createProxyRateLimiter(limit));
  app.all('/test', (_req, res) => res.json({ ok: true }));
  return app;
}

async function call(app: Express, options: { keyId?: number; ip?: string; method?: 'GET' | 'POST' } = {}) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/test`, {
    method: options.method ?? 'POST',
    headers: {
      ...(options.keyId ? { 'x-test-key-id': String(options.keyId) } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
    },
  });
  server.close();
  return response;
}

describe('proxy rate limiter consumer isolation', () => {
  it('does not share a reverse-proxy IP bucket across authenticated consumer keys', async () => {
    const app = createLimiterApp();
    expect((await call(app, { keyId: 1, ip: '203.0.113.1' })).status).toBe(200);
    expect((await call(app, { keyId: 1, ip: '203.0.113.1' })).status).toBe(200);
    expect((await call(app, { keyId: 2, ip: '203.0.113.1' })).status).toBe(200);
    expect((await call(app, { keyId: 1, ip: '203.0.113.1' })).status).toBe(429);
  });

  it('uses the same bucket for one consumer key across changing proxy IPs', async () => {
    const app = createLimiterApp();
    expect((await call(app, { keyId: 7, ip: '203.0.113.1' })).status).toBe(200);
    expect((await call(app, { keyId: 7, ip: '203.0.113.2' })).status).toBe(200);
    expect((await call(app, { keyId: 7, ip: '203.0.113.3' })).status).toBe(429);
  });

  it('does not count GET model polling against the generation budget', async () => {
    const app = createLimiterApp(1);
    for (let index = 0; index < 5; index++) {
      expect((await call(app, { keyId: 9, method: 'GET' })).status).toBe(200);
    }
    expect((await call(app, { keyId: 9 })).status).toBe(200);
    expect((await call(app, { keyId: 9 })).status).toBe(429);
  });
});
