import type { Db } from '../db/types.js';

export interface CreateResourceProductInput {
  productKey: string;
  name: string;
  description?: string | null;
  priceMicro: number;
  memberLimit: number;
  durationValue: number;
  durationUnit: 'day' | 'month';
  quotaAllocationType?: 'equal' | 'fixed';
  totalQuotaUnits: number;
  memberQuotaUnits: number;
  meterVersion?: string;
  groupTimeoutMinutes: number;
  refundWindowMinutes?: number;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
}

export interface ResourceProductRow {
  id: number;
  productKey: string;
  version: number;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'unpublished' | 'archived';
  priceMicro: number;
  memberLimit: number;
  durationValue: number;
  durationUnit: 'day' | 'month';
  quotaAllocationType: 'equal' | 'fixed';
  totalQuotaUnits: number;
  memberQuotaUnits: number;
  meterVersion: string;
  groupTimeoutMinutes: number;
  refundWindowMinutes: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const productSelect = `SELECT id, product_key productKey, version, name, description, status,
  price_micro priceMicro, member_limit memberLimit, duration_value durationValue,
  duration_unit durationUnit, quota_allocation_type quotaAllocationType,
  total_quota_units totalQuotaUnits, member_quota_units memberQuotaUnits,
  meter_version meterVersion, group_timeout_minutes groupTimeoutMinutes,
  refund_window_minutes refundWindowMinutes, sale_starts_at saleStartsAt, sale_ends_at saleEndsAt,
  published_at publishedAt, created_at createdAt, updated_at updatedAt
  FROM resource_products`;

export function getResourceProduct(db: Db, productId: number): ResourceProductRow | null {
  return db.prepare(`${productSelect} WHERE id = ?`).get(productId) as ResourceProductRow | undefined ?? null;
}

export function createResourceProduct(db: Db, input: CreateResourceProductInput): ResourceProductRow {
  const key = input.productKey.trim();
  const name = input.name.trim();
  if (!key || !name) throw new Error('Product key and name are required');
  validateResourceProductInput(input);
  const version = (db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 nextVersion FROM resource_products WHERE product_key = ?`).get(key) as { nextVersion: number }).nextVersion;
  const inserted = db.prepare(`INSERT INTO resource_products (
    product_key, version, name, description, price_micro, member_limit,
    duration_value, duration_unit, quota_allocation_type, total_quota_units,
    member_quota_units, meter_version, group_timeout_minutes, refund_window_minutes,
    sale_starts_at, sale_ends_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    key, version, name, input.description?.trim() || null, Math.trunc(input.priceMicro),
    Math.trunc(input.memberLimit), Math.trunc(input.durationValue), input.durationUnit,
    input.quotaAllocationType ?? 'equal', Math.trunc(input.totalQuotaUnits),
    Math.trunc(input.memberQuotaUnits), input.meterVersion?.trim() || 'tokens-v1', Math.trunc(input.groupTimeoutMinutes),
    Math.trunc(input.refundWindowMinutes ?? 60), input.saleStartsAt ?? null, input.saleEndsAt ?? null,
  );
  return getResourceProduct(db, Number(inserted.lastInsertRowid))!;
}

export function publishResourceProduct(db: Db, productId: number): ResourceProductRow {
  const product = getResourceProduct(db, productId);
  if (!product) throw new Error('Resource product was not found');
  validateResourceProductInput({ ...product, productKey: product.productKey });
  const updated = db.prepare(`UPDATE resource_products SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'draft'`).run(productId);
  if (updated.changes !== 1) throw new Error('Only a draft product can be published');
  return getResourceProduct(db, productId)!;
}

export function unpublishResourceProduct(db: Db, productId: number): ResourceProductRow {
  const updated = db.prepare(`UPDATE resource_products SET status = 'unpublished', updated_at = datetime('now') WHERE id = ? AND status = 'published'`).run(productId);
  if (updated.changes !== 1) throw new Error('Only a published product can be unpublished');
  return getResourceProduct(db, productId)!;
}

export function createNextResourceProductVersion(
  db: Db,
  sourceProductId: number,
  overrides: Partial<Omit<CreateResourceProductInput, 'productKey'>> = {},
): ResourceProductRow {
  const source = getResourceProduct(db, sourceProductId);
  if (!source || source.status === 'draft') throw new Error('A published product version is required');
  return createResourceProduct(db, {
    productKey: source.productKey,
    name: overrides.name ?? source.name,
    description: overrides.description ?? source.description,
    priceMicro: overrides.priceMicro ?? source.priceMicro,
    memberLimit: overrides.memberLimit ?? source.memberLimit,
    durationValue: overrides.durationValue ?? source.durationValue,
    durationUnit: overrides.durationUnit ?? source.durationUnit,
    quotaAllocationType: overrides.quotaAllocationType ?? source.quotaAllocationType,
    totalQuotaUnits: overrides.totalQuotaUnits ?? source.totalQuotaUnits,
    memberQuotaUnits: overrides.memberQuotaUnits ?? source.memberQuotaUnits,
    meterVersion: overrides.meterVersion ?? source.meterVersion,
    groupTimeoutMinutes: overrides.groupTimeoutMinutes ?? source.groupTimeoutMinutes,
    refundWindowMinutes: overrides.refundWindowMinutes ?? source.refundWindowMinutes,
    saleStartsAt: overrides.saleStartsAt ?? source.saleStartsAt,
    saleEndsAt: overrides.saleEndsAt ?? source.saleEndsAt,
  });
}

function validateResourceProductInput(input: CreateResourceProductInput): void {
  const integers = [input.priceMicro, input.memberLimit, input.durationValue, input.totalQuotaUnits,
    input.memberQuotaUnits, input.groupTimeoutMinutes, input.refundWindowMinutes ?? 60];
  if (!integers.every(Number.isSafeInteger)) throw new Error('Product numeric fields must be safe integers');
  if (input.priceMicro <= 0) throw new Error('Product price must be greater than zero');
  if (input.memberLimit < 2) throw new Error('Product member limit must be at least two');
  if (input.durationValue <= 0 || !['day', 'month'].includes(input.durationUnit)) throw new Error('Product duration is invalid');
  if (input.totalQuotaUnits <= 0 || input.memberQuotaUnits <= 0) throw new Error('Product quota must be greater than zero');
  if (input.memberQuotaUnits > Math.floor(input.totalQuotaUnits / input.memberLimit)) throw new Error('Member quota promise exceeds total product quota');
  if (!['equal', 'fixed'].includes(input.quotaAllocationType ?? 'equal')) throw new Error('Product quota allocation rule is invalid');
  if (input.meterVersion !== undefined && !input.meterVersion.trim()) throw new Error('Product meter version is required');
  if (input.groupTimeoutMinutes <= 0 || (input.refundWindowMinutes ?? 60) < 0) throw new Error('Product timeout rules are invalid');
}
