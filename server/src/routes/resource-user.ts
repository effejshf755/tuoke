import { Router, type Request } from 'express';
import { getDb } from '../db/index.js';
import {
  getPublishedResourceProduct,
  listPublishedResourceProducts,
  listUserResourceOrders,
  listUserResourceSubscriptions,
  listUserResourceUsage,
} from '../services/resource-user.js';
import {
  purchaseResourceProduct,
  refundResourcePurchase,
  ResourcePurchaseError,
} from '../services/resource-purchase.js';

export const resourceUserRouter = Router();

function currentUserId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

resourceUserRouter.get('/products', (_req, res) => {
  res.json({ products: listPublishedResourceProducts(getDb()) });
});

resourceUserRouter.get('/products/:id', (req, res) => {
  const product = getPublishedResourceProduct(getDb(), Number(req.params.id));
  if (!product) {
    res.status(404).json({ error: { type: 'resource_product_not_found' } });
    return;
  }
  res.json({ product });
});

resourceUserRouter.get('/orders', (req, res) => {
  res.json({ orders: listUserResourceOrders(getDb(), currentUserId(req)) });
});

resourceUserRouter.get('/subscriptions', (req, res) => {
  res.json({ subscriptions: listUserResourceSubscriptions(getDb(), currentUserId(req)) });
});

resourceUserRouter.get('/usage', (req, res) => {
  res.json({ records: listUserResourceUsage(getDb(), currentUserId(req), Number(req.query.limit ?? 100)) });
});

resourceUserRouter.post('/products/:id/purchase', (req, res) => {
  try {
    res.status(201).json(purchaseResourceProduct(getDb(), {
      userId: currentUserId(req),
      productId: Number(req.params.id),
      idempotencyKey: String(req.body?.idempotencyKey ?? ''),
    }));
  } catch (error) {
    const type = error instanceof ResourcePurchaseError ? error.code : 'resource_purchase_failed';
    const status = type === 'insufficient_balance' ? 409 : type === 'invalid_idempotency_key' ? 400 : 409;
    res.status(status).json({ error: { type, message: error instanceof Error ? error.message : String(error) } });
  }
});

resourceUserRouter.post('/orders/:id/refund', (req, res) => {
  try {
    res.json(refundResourcePurchase(getDb(), {
      userId: currentUserId(req),
      orderId: Number(req.params.id),
    }));
  } catch (error) {
    const type = error instanceof ResourcePurchaseError ? error.code : 'resource_refund_failed';
    res.status(409).json({ error: { type, message: error instanceof Error ? error.message : String(error) } });
  }
});
