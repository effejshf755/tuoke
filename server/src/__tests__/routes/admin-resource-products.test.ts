import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createResourceOrder } from '../../services/resource-orders.js';
import { groupPaidResourceOrder, markResourceOrderPaidForGrouping } from '../../services/resource-grouping.js';

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

  it('automatically creates a new version for an existing product key', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'codex-pro20-group', name: 'Duplicate', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 100, memberQuotaUnits: 50, groupTimeoutMinutes: 60,
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({ productKey: 'codex-pro20-group', version: 2, status: 'draft' });
  });

  it('rejects unsupported resource metering versions', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'unsupported-meter', name: 'Unsupported meter', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month',
      totalQuotaUnits: 100, memberQuotaUnits: 50, meterVersion: 'credits-v1',
      groupTimeoutMinutes: 60,
    }, adminToken);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/only tokens-v1 and points-v1/i);
  });

  it('creates a draft product using points-v1 metering', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'codex-pro-x20', name: 'Codex points plan', priceMicro: 700_000_000,
      memberLimit: 2, durationValue: 1, durationUnit: 'month',
      quotaAllocationType: 'equal', totalQuotaUnits: 10_000, memberQuotaUnits: 5_000,
      meterVersion: 'points-v1', groupTimeoutMinutes: 10_080,
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      productKey: 'codex-pro-x20', meterVersion: 'points-v1',
      totalQuotaUnits: 10_000, memberQuotaUnits: 5_000, status: 'draft',
    });
  });

  it('allows equal allocation to ignore an indivisible remainder', async () => {
    const response = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'codex-pro-x20-three', name: 'Codex three-person plan', priceMicro: 466_666_667,
      memberLimit: 3, durationValue: 1, durationUnit: 'month',
      quotaAllocationType: 'equal', totalQuotaUnits: 10_000, memberQuotaUnits: 3_333,
      meterVersion: 'points-v1', groupTimeoutMinutes: 10_080,
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      totalQuotaUnits: 10_000, memberQuotaUnits: 3_333, memberLimit: 3,
    });
  });

  it('creates changes as a new draft version while old orders retain version one', async () => {
    const oldOrder = createResourceOrder(getDb(), userId, firstProductId);
    const response = await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/new-version`, {
      priceMicro: 30_000_000,
      memberQuotaUnits: 200_000,
      totalQuotaUnits: 800_000,
      meterVersion: 'tokens-v1',
    }, adminToken);
    expect(response.status).toBe(201);
    expect(response.body.product).toMatchObject({
      productKey: 'codex-pro20-group', version: 3, status: 'draft',
      priceMicro: 30_000_000, memberQuotaUnits: 200_000, meterVersion: 'tokens-v1',
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

  it('publishes an unpublished product again', async () => {
    const republished = await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/publish`, {}, adminToken);
    expect(republished.status).toBe(200);
    expect(republished.body.product.status).toBe('published');
    const visible = await call(app, 'GET', '/api/resources/products', undefined, userToken);
    expect(visible.body.products.some((product: any) => product.id === firstProductId)).toBe(true);
    expect((await call(app, 'POST', `/api/admin/resources/products/${firstProductId}/unpublish`, {}, adminToken)).status).toBe(200);
  });

  it('deletes only an unpublished product without business history', async () => {
    const created = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'delete-empty-product', name: 'Delete empty product', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month', quotaAllocationType: 'equal',
      totalQuotaUnits: 100, memberQuotaUnits: 50, meterVersion: 'tokens-v1', groupTimeoutMinutes: 60,
    }, adminToken);
    const id = created.body.product.id;
    expect((await call(app, 'POST', `/api/admin/resources/products/${id}/publish`, {}, adminToken)).status).toBe(200);
    expect((await call(app, 'POST', `/api/admin/resources/products/${id}/unpublish`, {}, adminToken)).status).toBe(200);
    expect((await call(app, 'DELETE', `/api/admin/resources/products/${id}`, undefined, adminToken)).status).toBe(200);
    expect((await call(app, 'GET', `/api/admin/resources/products/${id}`, undefined, adminToken)).status).toBe(404);

    const protectedDelete = await call(app, 'DELETE', `/api/admin/resources/products/${firstProductId}`, undefined, adminToken);
    expect(protectedDelete.status).toBe(400);
    expect(protectedDelete.body.error.message).toMatch(/in-progress/i);
  });

  it('deletes an unpublished product when it has only terminal order history', async () => {
    const created = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'delete-terminal-product', name: 'Delete terminal product', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month', quotaAllocationType: 'equal',
      totalQuotaUnits: 100, memberQuotaUnits: 50, meterVersion: 'tokens-v1', groupTimeoutMinutes: 60,
    }, adminToken);
    const id = created.body.product.id;
    await call(app, 'POST', `/api/admin/resources/products/${id}/publish`, {}, adminToken);
    const order = createResourceOrder(getDb(), userId, id);
    getDb().prepare(`UPDATE resource_orders SET order_status = 'refunded' WHERE id = ?`).run(order.id);
    await call(app, 'POST', `/api/admin/resources/products/${id}/unpublish`, {}, adminToken);
    expect((await call(app, 'DELETE', `/api/admin/resources/products/${id}`, undefined, adminToken)).status).toBe(200);
    expect(getDb().prepare(`SELECT id FROM resource_orders WHERE id = ?`).get(order.id)).toBeUndefined();
  });

  it('deletes an unpublished product with a paused subpool but not a running subpool', async () => {
    const created = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'delete-paused-product', name: 'Delete paused product', priceMicro: 1,
      memberLimit: 2, durationValue: 1, durationUnit: 'month', quotaAllocationType: 'equal',
      totalQuotaUnits: 100, memberQuotaUnits: 50, meterVersion: 'tokens-v1', groupTimeoutMinutes: 60,
    }, adminToken);
    const id = created.body.product.id;
    await call(app, 'POST', `/api/admin/resources/products/${id}/publish`, {}, adminToken);
    const order = createResourceOrder(getDb(), userId, id);
    markResourceOrderPaidForGrouping(getDb(), order.id);
    const poolId = groupPaidResourceOrder(getDb(), order.id).subpoolId;
    getDb().prepare(`UPDATE resource_subpools SET status = 'active' WHERE id = ?`).run(poolId);
    await call(app, 'POST', `/api/admin/resources/products/${id}/unpublish`, {}, adminToken);
    expect((await call(app, 'DELETE', `/api/admin/resources/products/${id}`, undefined, adminToken)).status).toBe(400);
    getDb().prepare(`UPDATE resource_subpools SET status = 'paused' WHERE id = ?`).run(poolId);
    expect((await call(app, 'DELETE', `/api/admin/resources/products/${id}`, undefined, adminToken)).status).toBe(200);
    expect(getDb().prepare(`SELECT id FROM resource_subpools WHERE id = ?`).get(poolId)).toBeUndefined();
  });

  it('updates the same product row when there is no in-progress business', async () => {
    const created = await call(app, 'POST', '/api/admin/resources/products', {
      productKey: 'editable-product', name: 'Before edit', priceMicro: 10_000_000,
      memberLimit: 2, durationValue: 1, durationUnit: 'month', quotaAllocationType: 'equal',
      totalQuotaUnits: 1000, memberQuotaUnits: 500, meterVersion: 'tokens-v1', groupTimeoutMinutes: 60,
    }, adminToken);
    const id = created.body.product.id;
    const updated = await call(app, 'PUT', `/api/admin/resources/products/${id}`, {
      name: 'After edit', priceMicro: 12_000_000, memberLimit: 2,
      durationValue: 1, durationUnit: 'month', quotaAllocationType: 'equal',
      totalQuotaUnits: 1200, memberQuotaUnits: 600, meterVersion: 'tokens-v1',
      groupTimeoutMinutes: 120, refundWindowMinutes: 30,
    }, adminToken);
    expect(updated.status).toBe(200);
    expect(updated.body.product).toMatchObject({ id, version: 1, name: 'After edit', priceMicro: 12_000_000, memberQuotaUnits: 600 });
    expect((getDb().prepare(`SELECT COUNT(*) count FROM resource_products WHERE product_key = 'editable-product'`).get() as { count: number }).count).toBe(1);
  });

  it('rejects editing a product with an in-progress order', async () => {
    const response = await call(app, 'PUT', `/api/admin/resources/products/${firstProductId}`, {
      name: 'Must not change',
    }, adminToken);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/currently grouping/i);
    expect((getDb().prepare(`SELECT name FROM resource_products WHERE id = ?`).get(firstProductId) as { name: string }).name).not.toBe('Must not change');
  });
});
