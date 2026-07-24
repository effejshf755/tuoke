import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createResourceOrder } from '../../services/resource-orders.js';

async function call(app: Express, method: string, path: string, body?: unknown, token?: string) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('admin resource product API', () => {
  let app: Express;
  let adminToken: string;
  let userToken: string;
  let userId: number;
  let firstProductId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '1'.repeat(64);
    initDb(':memory:');
    app = createApp();
    const admin = createUser('product-admin@example.com', 'supersecret');
    const user = createUser('product-user@example.com', 'supersecret');
    adminToken = createSession(admin.userId);
    userToken = createSession(user.userId);
    userId = user.userId;
  });

  it('requires an authenticated administrator', async () => {
    expect((await call(app, 'GET', '/api/admin/resources/products')).status).toBe(401);
    expect((await call(app, 'GET', '/api/admin/resources/products', undefined, userToken)).status).toBe(403);
  });

  it('creates a draft product', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'codex-pro20-group',
      name: 'Codex Pro20 四人拼单',
      description: 'Monthly Codex entitlement',
      priceMicro: 25_000_000,
      memberLimit: 4,
      durationValue: 1,
      durationUnit: 'month',
      quotaAllocationType: 'equal',
      totalQuotaUnits: 1_000_000,
      memberQuotaUnits: 250_000,
      meterVersion: 'tokens-v1',
      groupTimeoutMinutes: 10_080,
      refundWindowMinutes: 60,
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      productKey: 'codex-pro20-group', version: 1, status: 'draft',
      priceMicro: 25_000_000, memberQuotaUnits: 250_000,
    });
    firstProductId = response.body.product.id;
    const detail = await call(app, 'GET', `/api/admin/resources/products/${firstProductId}`, undefined, adminToken);
    expect(detail.status).toBe(200);
    expect(detail.body.product.id).toBe(firstProductId);
  });

  it('publishes a valid draft product', async () => {
    const response = await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/publish`, {}, adminToken);
    expect(response.status).toBe(200);
    expect(response.body.product.status).toBe('published');
    const visible = await call(app, 'GET', '/api/resources/products', undefined, userToken);
    expect(visible.body.products.some((product: any) => product.id === firstProductId)).toBe(true);
  });

  it('requires the version endpoint for an existing product key', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'codex-pro20-group', name: 'Duplicate', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 100, memberQuotaUnits: 50, groupTimeoutMinutes: 60,
    }, adminToken);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/new version/i);
  });

  it('creates changes as a new draft version while old orders retain version one', async () => {
    const oldOrder = createResourceOrder(getDb(), userId, firstProductId);
    const response = await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/new-version`, {
      priceMicro: 30_000_000,
      memberQuotaUnits: 200_000,
      totalQuotaUnits: 800_000,
      meterVersion: 'tokens-v2',
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      productKey: 'codex-pro20-group', version: 2, status: 'draft',
      priceMicro: 30_000_000, memberQuotaUnits: 200_000, meterVersion: 'tokens-v2',
    });
    const oldProduct = await call(app, 'GET', `/api/admin/resources/products/${firstProductId}`, undefined, adminToken);
    expect(oldProduct.body.product).toMatchObject({ version: 1, priceMicro: 25_000_000, memberQuotaUnits: 250_000 });
    expect(getDb().prepare(`SELECT product_id productId, product_version productVersion,
      price_micro priceMicro, member_quota_units_snapshot memberQuotaUnits
      FROM resource_orders WHERE id = ?`).get(oldOrder.id)).toEqual({
      productId: firstProductId,
      productVersion: 1,
      priceMicro: 25_000_000,
      memberQuotaUnits: 250_000,
    });
  });

  it('removes an unpublished product from the user marketplace', async () => {
    const response = await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/unpublish`, {}, adminToken);
    expect(response.status).toBe(200);
    expect(response.body.product.status).toBe('unpublished');
    const visible = await call(app, 'GET', '/api/resources/products', undefined, userToken);
    expect(visible.body.products.some((product: any) => product.id === firstProductId)).toBe(false);
  });
});
