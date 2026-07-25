import { Router, type Request } from 'express';
import { getDb } from '../db/index.js';
import { activateSubpool, clearStagedSubpoolCodexAccount, stageSubpoolCodexAccount } from '../services/resource-subpool-activation.js';
import { recordResourceAdminAudit, listResourceAdminAuditLogs } from '../services/resource-admin-audit.js';
import {
  adjustResourceMemberQuota,
  getResourceMemberQuota,
  getResourceSubpoolDetail,
  listAvailableCodexAccounts,
  listResourceProductStats,
  listResourceSubpools,
  listResourceUsageRecords,
} from '../services/resource-admin-operations.js';
import {
  createNextResourceProductVersion,
  createResourceProduct,
  deleteUnpublishedResourceProduct,
  getResourceProduct,
  publishResourceProduct,
  unpublishResourceProduct,
  updateResourceProduct,
  type CreateResourceProductInput,
} from '../services/resource-products.js';
import { getResourcePointsPolicy, updateResourcePointsPolicy } from '../services/resource-points.js';
import {
  ADMIN_RESOURCE_ORDER_STATUSES,
  adminCancelResourceSubpool,
  adminDeleteResourceSubpool,
  adminDeleteRefundedResourceOrders,
  adminRefundResourceOrder,
  getAdminResourceOrderDetail,
  listAdminResourceOrders,
  type AdminResourceOrderStatus,
} from '../services/resource-admin-orders.js';
import {
  changeResourceSubpoolAccount,
  pauseResourceSubpool,
  resumeResourceSubpool,
  unbindResourceSubpoolAccount,
} from '../services/resource-subpool-operations.js';
import { listResourceAlerts, resolveResourceAlert } from '../services/resource-alerts.js';

export const adminResourcesRouter = Router();

function adminId(req: Request): number {
  const id = (req as typeof req & { user?: { userId?: number } }).user?.userId;
  if (!id) throw new Error('Authenticated administrator is required');
  return id;
}

adminResourcesRouter.get('/products', (_req, res) => {
  res.json({ products: listResourceProductStats(getDb()) });
});

adminResourcesRouter.get('/points-policy', (_req, res) => {
  res.json(getResourcePointsPolicy(getDb()));
});

adminResourcesRouter.put('/points-policy', (req, res) => {
  try {
    const updated = updateResourcePointsPolicy(getDb(), {
      officialQuotaFloorPercent: Number(req.body?.officialQuotaFloorPercent),
      defaultInputMultiplier: Number(req.body?.defaultInputMultiplier),
      defaultCachedInputMultiplier: Number(req.body?.defaultCachedInputMultiplier),
      defaultOutputMultiplier: Number(req.body?.defaultOutputMultiplier),
      models: Array.isArray(req.body?.models) ? req.body.models : [],
    });
    recordResourceAdminAudit(getDb(), { adminUserId: adminId(req), action: 'resource_points_policy_updated',
      targetType: 'resource_quota_policy', targetId: 1, details: req.body });
    res.json(updated);
  } catch (error) { productError(res, error); }
});

function productInput(body: any): CreateResourceProductInput {
  return {
    productKey: String(body?.productKey ?? body?.product_key ?? ''),
    name: String(body?.name ?? ''),
    description: body?.description == null ? null : String(body.description),
    priceMicro: Number(body?.priceMicro ?? body?.price_micro),
    memberLimit: Number(body?.memberLimit ?? body?.member_limit),
    durationValue: Number(body?.durationValue ?? body?.duration_value),
    durationUnit: body?.durationUnit ?? body?.duration_unit,
    quotaAllocationType: body?.quotaAllocationType ?? body?.quota_allocation_type ?? 'equal',
    totalQuotaUnits: Number(body?.totalQuotaUnits ?? body?.total_quota_units),
    memberQuotaUnits: Number(body?.memberQuotaUnits ?? body?.member_quota_units),
    meterVersion: String(body?.meterVersion ?? body?.meter_version ?? 'tokens-v1'),
    groupTimeoutMinutes: Number(body?.groupTimeoutMinutes ?? body?.group_timeout_minutes),
    refundWindowMinutes: Number(body?.refundWindowMinutes ?? body?.refund_window_minutes ?? 60),
    saleStartsAt: body?.saleStartsAt ?? body?.sale_starts_at ?? null,
    saleEndsAt: body?.saleEndsAt ?? body?.sale_ends_at ?? null,
  };
}

function productOverrides(body: any): Partial<Omit<CreateResourceProductInput, 'productKey'>> {
  const aliases: Array<[keyof Omit<CreateResourceProductInput, 'productKey'>, string, string]> = [
    ['name', 'name', 'name'], ['description', 'description', 'description'],
    ['priceMicro', 'priceMicro', 'price_micro'], ['memberLimit', 'memberLimit', 'member_limit'],
    ['durationValue', 'durationValue', 'duration_value'], ['durationUnit', 'durationUnit', 'duration_unit'],
    ['quotaAllocationType', 'quotaAllocationType', 'quota_allocation_type'],
    ['totalQuotaUnits', 'totalQuotaUnits', 'total_quota_units'],
    ['memberQuotaUnits', 'memberQuotaUnits', 'member_quota_units'],
    ['meterVersion', 'meterVersion', 'meter_version'],
    ['groupTimeoutMinutes', 'groupTimeoutMinutes', 'group_timeout_minutes'],
    ['refundWindowMinutes', 'refundWindowMinutes', 'refund_window_minutes'],
    ['saleStartsAt', 'saleStartsAt', 'sale_starts_at'], ['saleEndsAt', 'saleEndsAt', 'sale_ends_at'],
  ];
  const result: Record<string, unknown> = {};
  for (const [target, camel, snake] of aliases) {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, camel) || Object.prototype.hasOwnProperty.call(body ?? {}, snake)) {
      const raw = body?.[camel] ?? body?.[snake];
      result[target] = ['priceMicro', 'memberLimit', 'durationValue', 'totalQuotaUnits', 'memberQuotaUnits',
        'groupTimeoutMinutes', 'refundWindowMinutes'].includes(target) ? Number(raw) : raw;
    }
  }
  return result as Partial<Omit<CreateResourceProductInput, 'productKey'>>;
}

function productError(res: Parameters<Parameters<typeof adminResourcesRouter.post>[1]>[1], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Only a|published product version/i.test(message) ? 409 : 400;
  res.status(status).json({ error: { type: 'resource_product_operation_failed', message } });
}

adminResourcesRouter.post('/products', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const input = productInput(req.body);
      const existing = db.prepare(`SELECT id FROM resource_products
        WHERE product_key = ? AND status <> 'draft' ORDER BY version DESC LIMIT 1`).get(input.productKey.trim()) as { id: number } | undefined;
      const created = existing
        ? createNextResourceProductVersion(db, existing.id, input)
        : createResourceProduct(db, input);
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: existing ? 'product_version_created' : 'product_created', targetType: 'resource_product', targetId: created.id, details: { productKey: created.productKey, version: created.version, sourceProductId: existing?.id ?? null } });
      return created;
    })();
    res.status(201).json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.get('/products/:id', (req, res) => {
  const product = getResourceProduct(getDb(), Number(req.params.id));
  if (!product) { res.status(404).json({ error: { type: 'resource_product_not_found' } }); return; }
  res.json({ product });
});

adminResourcesRouter.put('/products/:id', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const updated = updateResourceProduct(db, Number(req.params.id), productOverrides(req.body));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'product_updated', targetType: 'resource_product', targetId: updated.id, details: { productKey: updated.productKey, version: updated.version } });
      return updated;
    })();
    res.json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.post('/products/:id/publish', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const published = publishResourceProduct(db, Number(req.params.id));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'product_published', targetType: 'resource_product', targetId: published.id, details: { productKey: published.productKey, version: published.version } });
      return published;
    })();
    res.json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.post('/products/:id/unpublish', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const unpublished = unpublishResourceProduct(db, Number(req.params.id));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'product_unpublished', targetType: 'resource_product', targetId: unpublished.id, details: { productKey: unpublished.productKey, version: unpublished.version } });
      return unpublished;
    })();
    res.json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.delete('/products/:id', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const deleted = deleteUnpublishedResourceProduct(db, Number(req.params.id));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'product_deleted', targetType: 'resource_product', targetId: deleted.id, details: { productKey: deleted.productKey, version: deleted.version } });
      return deleted;
    })();
    res.json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.post('/products/:id/new-version', (req, res) => {
  const db = getDb();
  try {
    const product = db.transaction(() => {
      const created = createNextResourceProductVersion(db, Number(req.params.id), productOverrides(req.body));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'product_version_created', targetType: 'resource_product', targetId: created.id, details: { productKey: created.productKey, version: created.version, sourceProductId: Number(req.params.id) } });
      return created;
    })();
    res.status(201).json({ product });
  } catch (error) { productError(res, error); }
});

adminResourcesRouter.get('/orders', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !ADMIN_RESOURCE_ORDER_STATUSES.includes(status as AdminResourceOrderStatus)) {
    res.status(400).json({ error: { type: 'invalid_resource_order_status' } });
    return;
  }
  res.json({ orders: listAdminResourceOrders(getDb(), status as AdminResourceOrderStatus | undefined) });
});

adminResourcesRouter.get('/orders/:id', (req, res) => {
  const detail = getAdminResourceOrderDetail(getDb(), Number(req.params.id));
  if (!detail) { res.status(404).json({ error: { type: 'resource_order_not_found' } }); return; }
  res.json(detail);
});

adminResourcesRouter.post('/orders/:id/refund', (req, res) => {
  try {
    res.json(adminRefundResourceOrder(getDb(), {
      orderId: Number(req.params.id),
      adminId: adminId(req),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : 409).json({
      error: { type: 'resource_order_refund_failed', message },
    });
  }
});

adminResourcesRouter.delete('/orders', (req, res) => {
  try {
    res.json(adminDeleteRefundedResourceOrders(getDb(), {
      orderIds: Array.isArray(req.body?.orderIds) ? req.body.orderIds : [],
      adminId: adminId(req),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : 409).json({ error: { type: 'resource_order_delete_failed', message } });
  }
});

adminResourcesRouter.get('/available-codex-accounts', (_req, res) => {
  res.json({ accounts: listAvailableCodexAccounts(getDb()) });
});

adminResourcesRouter.get('/audit-logs', (req, res) => {
  const subpoolId = req.query.subpoolId === undefined ? undefined : Number(req.query.subpoolId);
  res.json({ logs: listResourceAdminAuditLogs(getDb(), { subpoolId, limit: Number(req.query.limit ?? 100) }) });
});

adminResourcesRouter.get('/alerts', (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  res.json({ alerts: listResourceAlerts(getDb(), status, Number(req.query.limit ?? 100)) });
});

adminResourcesRouter.post('/alerts/:id/resolve', (req, res) => {
  const db = getDb();
  const alertId = Number(req.params.id);
  const resolved = db.transaction(() => {
    const changed = resolveResourceAlert(db, alertId, adminId(req));
    if (changed) recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'resource_alert_resolved', targetType: 'resource_operational_alert', targetId: alertId, details: {} });
    return changed;
  })();
  if (!resolved) { res.status(404).json({ error: { type: 'resource_alert_not_found' } }); return; }
  res.json({ resolved: true });
});

adminResourcesRouter.get('/subpools', (req, res) => {
  res.json({ subpools: listResourceSubpools(getDb(), typeof req.query.status === 'string' ? req.query.status : undefined) });
});

adminResourcesRouter.get('/subpools/:id', (req, res) => {
  const detail = getResourceSubpoolDetail(getDb(), Number(req.params.id));
  if (!detail) { res.status(404).json({ error: { type: 'resource_subpool_not_found' } }); return; }
  res.json(detail);
});

adminResourcesRouter.post('/subpools/:id/cancel-and-refund', (req, res) => {
  try {
    res.json(adminCancelResourceSubpool(getDb(), {
      subpoolId: Number(req.params.id),
      adminId: adminId(req),
    }));
  } catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.delete('/subpools/:id', (req, res) => {
  try {
    res.json(adminDeleteResourceSubpool(getDb(), {
      subpoolId: Number(req.params.id),
      adminId: adminId(req),
    }));
  } catch (error) { subpoolOperationError(res, error); }
});

function subpoolOperationError(res: Parameters<Parameters<typeof adminResourcesRouter.post>[1]>[1], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(/not found/i.test(message) ? 404 : 409).json({
    error: { type: 'resource_subpool_operation_failed', message },
  });
}

adminResourcesRouter.post('/subpools/:id/pause', (req, res) => {
  try { res.json(pauseResourceSubpool(getDb(), Number(req.params.id), adminId(req))); }
  catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.post('/subpools/:id/resume', (req, res) => {
  try { res.json(resumeResourceSubpool(getDb(), Number(req.params.id), adminId(req))); }
  catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.post('/subpools/:id/unbind-account', (req, res) => {
  try { res.json(unbindResourceSubpoolAccount(getDb(), Number(req.params.id), adminId(req))); }
  catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.post('/subpools/:id/change-account', (req, res) => {
  const accountId = Number(req.body?.accountId ?? req.body?.codexAccountId ?? req.body?.codex_account_id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: { type: 'invalid_codex_account_id' } });
    return;
  }
  try {
    res.json(changeResourceSubpoolAccount(getDb(), {
      subpoolId: Number(req.params.id), accountId, adminId: adminId(req),
    }));
  } catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.get('/subpools/:id/members/:memberId/quota', (req, res) => {
  const quota = getResourceMemberQuota(getDb(), Number(req.params.id), Number(req.params.memberId));
  if (!quota) { res.status(404).json({ error: { type: 'resource_member_quota_not_found' } }); return; }
  res.json({ quota });
});

adminResourcesRouter.get('/subpools/:id/usage', (req, res) => {
  res.json({ records: listResourceUsageRecords(getDb(), {
    subpoolId: Number(req.params.id),
    memberId: req.query.memberId === undefined ? undefined : Number(req.query.memberId),
    limit: Number(req.query.limit ?? 100),
  }) });
});

adminResourcesRouter.post('/subpools/:id/members/:memberId/quota-adjustments', (req, res) => {
  try {
    res.json(adjustResourceMemberQuota(getDb(), {
      subpoolId: Number(req.params.id), memberId: Number(req.params.memberId),
      deltaUnits: Number(req.body?.deltaUnits), reason: String(req.body?.reason ?? ''), adminId: adminId(req),
    }));
  } catch (error) {
    res.status(409).json({ error: { type: 'resource_quota_adjustment_failed', message: error instanceof Error ? error.message : String(error) } });
  }
});

adminResourcesRouter.post('/subpools', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (req.body?.mode === 'scheduled') { res.status(501).json({ error: { type: 'scheduled_not_enabled' } }); return; }
  const mode = 'dedicated';
  const memberLimit = Math.trunc(Number(req.body?.memberLimit));
  if (!name || !Number.isSafeInteger(memberLimit) || memberLimit < 1) {
    res.status(400).json({ error: { type: 'invalid_resource_subpool', message: 'name and a positive memberLimit are required.' } }); return;
  }
  const status = req.body?.status === 'active' ? 'active' : 'waiting_members';
  const db = getDb();
  const id = db.transaction(() => {
    const result = db.prepare(`INSERT INTO resource_subpools (name, mode, status, member_limit, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, mode, status, memberLimit, req.body?.startsAt ?? null, req.body?.endsAt ?? null);
    const createdId = Number(result.lastInsertRowid);
    recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'subpool_created', targetType: 'resource_subpool', targetId: createdId, subpoolId: createdId, details: { name, memberLimit } });
    return createdId;
  })();
  res.status(201).json({ id, mode, status });
});

adminResourcesRouter.post('/subpools/:id/members', (req, res) => {
  const db = getDb(); const subpoolId = Number(req.params.id); const userId = Number(req.body?.userId); const consumerApiKeyId = Number(req.body?.consumerApiKeyId);
  const pool = db.prepare(`SELECT member_limit memberLimit, (SELECT COUNT(*) FROM resource_subpool_members WHERE subpool_id = ? AND status IN ('waiting','active')) memberCount FROM resource_subpools WHERE id = ?`).get(subpoolId, subpoolId) as any;
  if (!pool) { res.status(404).json({ error: { type: 'resource_subpool_not_found' } }); return; }
  if (pool.memberCount >= pool.memberLimit) { res.status(409).json({ error: { type: 'resource_subpool_full' } }); return; }
  if (!Number.isSafeInteger(consumerApiKeyId)) { res.status(400).json({ error: { type: 'codex_api_key_required' } }); return; }
  const key = db.prepare(`SELECT 1 FROM consumer_api_keys WHERE id = ? AND user_id = ? AND key_scope = 'resource_subpool'`).get(consumerApiKeyId, userId);
  if (!key) { res.status(400).json({ error: { type: 'invalid_codex_api_key' } }); return; }
  const id = db.transaction(() => {
    const result = db.prepare(`INSERT INTO resource_subpool_members (subpool_id, user_id, consumer_api_key_id, status, activated_at) VALUES (?, ?, ?, 'active', datetime('now'))`).run(subpoolId, userId, consumerApiKeyId);
    const createdId = Number(result.lastInsertRowid);
    recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'subpool_member_added', targetType: 'resource_subpool_member', targetId: createdId, subpoolId, details: { userId, consumerApiKeyId } });
    return createdId;
  })();
  res.status(201).json({ id });
});

adminResourcesRouter.put('/subpools/:id/binding', (req, res) => {
  const db = getDb(); const subpoolId = Number(req.params.id); const accountId = Number(req.body?.codexAccountId);
  try {
    stageSubpoolCodexAccount(db, subpoolId, accountId, adminId(req));
    res.status(204).end();
  } catch (error) { res.status(409).json({ error: { type: 'resource_binding_conflict', message: error instanceof Error ? error.message : String(error) } }); }
});

adminResourcesRouter.post('/subpools/:id/clear-pending-account', (req, res) => {
  try {
    clearStagedSubpoolCodexAccount(getDb(), Number(req.params.id), adminId(req));
    res.json({ cleared: true });
  } catch (error) { subpoolOperationError(res, error); }
});

adminResourcesRouter.post('/subpools/:id/activate', (req, res) => {
  const adminId = (req as typeof req & { user?: { userId?: number } }).user?.userId;
  if (!adminId) { res.status(401).json({ error: { type: 'authentication_required' } }); return; }
  try {
    res.json(activateSubpool(getDb(), Number(req.params.id), adminId));
  } catch (error) {
    res.status(409).json({ error: { type: 'resource_subpool_activation_failed', message: error instanceof Error ? error.message : String(error) } });
  }
});

adminResourcesRouter.post('/subpools/:id/quota-periods', (req, res) => {
  const db = getDb(); const subpoolId = Number(req.params.id); const allocation = Math.trunc(Number(req.body?.allocationUnits));
  const allocations = Array.isArray(req.body?.memberAllocations) ? req.body.memberAllocations : [];
  if (!Number.isSafeInteger(allocation) || allocation < 0 || !String(req.body?.periodKey ?? '').trim()) {
    res.status(400).json({ error: { type: 'invalid_quota_period' } }); return;
  }
  try {
    const periodId = db.transaction(() => {
      const inserted = db.prepare(`INSERT INTO resource_subpool_quota_periods (subpool_id, period_key, source_type, allocation_units, starts_at, resets_at) VALUES (?, ?, 'admin', ?, ?, ?)`)
        .run(subpoolId, String(req.body.periodKey), allocation, req.body?.startsAt ?? new Date().toISOString(), req.body?.resetsAt ?? null);
      const id = Number(inserted.lastInsertRowid);
      for (const item of allocations) db.prepare(`INSERT INTO resource_member_quotas (subpool_period_id, member_id, allocation_units) VALUES (?, ?, ?)`).run(id, Number(item.memberId), Math.trunc(Number(item.allocationUnits)));
      recordResourceAdminAudit(db, { adminUserId: adminId(req), action: 'quota_period_created', targetType: 'resource_subpool_quota_period', targetId: id, subpoolId, details: { allocationUnits: allocation, periodKey: String(req.body.periodKey) } });
      return id;
    })();
    res.status(201).json({ id: periodId });
  } catch (error) { res.status(409).json({ error: { type: 'quota_period_conflict', message: error instanceof Error ? error.message : String(error) } }); }
});

adminResourcesRouter.get('/scheduler-pools', (_req, res) => {
  res.json(getDb().prepare(`SELECT * FROM resource_scheduler_pools ORDER BY id DESC`).all());
});

adminResourcesRouter.post('/scheduler-pools', (req, res) => {
  void req;
  res.status(501).json({ error: { type: 'scheduled_not_enabled' } });
});

adminResourcesRouter.post('/scheduler-pools/:id/assets', (req, res) => {
  void req;
  res.status(501).json({ error: { type: 'scheduled_not_enabled' } });
});

adminResourcesRouter.post('/subpools/:id/enable-scheduled', (_req, res) => {
  res.status(501).json({ error: { type: 'scheduled_not_enabled', message: 'Scheduled mode is reserved for V2.' } });
});
