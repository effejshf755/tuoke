import { randomUUID } from 'crypto';

import { Router } from 'express';
import type { Request } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { createPagePayment, isAlipayConfigured, settleAlipayOrder, verifyNotify } from '../services/alipay.js';
import { activateRechargedFreeTier } from '../services/free-model-access.js';

export const userRechargeRouter =
  Router();

export const adminRechargeRouter =
  Router();

export const alipayNotifyRouter = Router();

const MANUAL_RECHARGE_THRESHOLD_MICRO = 100_000_000;
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

const createOrderSchema =
  z.object({
    amount: z
      .number()
      .positive()
      .max(1_000_000_000),

    payment_method: z
      .enum([
        'manual',
        'alipay',
        'wechat',
      ])
      .default('manual'),
  });

const markPaidSchema =
  z.object({
    provider_trade_no: z
      .string()
      .trim()
      .max(200)
      .optional(),

    note: z
      .string()
      .trim()
      .max(500)
      .optional(),
  });

function getUserId(
  req: Request,
): number {
  return (
    req as Request & {
      user: {
        userId: number;
      };
    }
  ).user.userId;
}

function yuanToMicro(
  value: number,
): number {
  const result =
    Math.round(
      value * 1_000_000,
    );

  if (
    !Number.isSafeInteger(
      result,
    ) ||
    result <= 0
  ) {
    throw new Error(
      'Invalid recharge amount',
    );
  }

  return result;
}

function microToYuan(
  value: number,
): number {
  return value / 1_000_000;
}

function createOrderNo(): string {
  const random =
    randomUUID()
      .replace(
        /-/g,
        '',
      )
      .slice(
        0,
        10,
      )
      .toUpperCase();

  return `R${Date.now()}${random}`;
}

function createPaymentReference(): string {
  return `TK${Date.now().toString().slice(-6)}${Math.floor(1000 + Math.random() * 9000)}`;
}

function expireRechargeOrders(): void {
  getDb().prepare("UPDATE recharge_orders SET status='expired', updated_at=datetime('now') WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= datetime('now') AND (payment_method <> 'manual' OR proof_submitted_at IS NULL)").run();
}

/** Alipay asynchronous notification. This endpoint must remain unauthenticated. */
alipayNotifyRouter.post('/', (req, res) => {
  const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([key, value]) => [key, Array.isArray(value) ? String(value[0]) : String(value ?? '')]));
  if (!verifyNotify(params)) { res.status(400).send('fail'); return; }
  if (params.trade_status !== 'TRADE_SUCCESS' && params.trade_status !== 'TRADE_FINISHED') { res.send('success'); return; }
  const order = getDb().prepare('SELECT amount_micro amountMicro FROM recharge_orders WHERE order_no=?').get(params.out_trade_no) as { amountMicro:number } | undefined;
  const paidYuan = Number(params.total_amount);
  if (!order || !Number.isFinite(paidYuan) || Math.round(paidYuan * 1_000_000) !== order.amountMicro) { res.status(400).send('fail'); return; }
  try {
    settleAlipayOrder(getDb(), params.out_trade_no, params.trade_no, 'Alipay asynchronous notification');
    res.send('success');
  } catch (error) {
    console.error('[Alipay] notification settlement failed:', error);
    res.status(500).send('fail');
  }
});

/*
 * ==========================================================
 * USER
 * ==========================================================
 */

/**
 * POST /api/user/recharge/orders
 *
 * Create a pending recharge order.
 */
userRechargeRouter.post(
  '/orders',
  (req, res) => {
    expireRechargeOrders();
    const parsed =
      createOrderSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            'Invalid recharge request',

          type:
            'invalid_request',

          details:
            parsed.error.flatten(),
        },
      });

      return;
    }

    const userId =
      getUserId(req);

    const amountMicro =
      yuanToMicro(
        parsed.data.amount,
      );
    if (parsed.data.payment_method === 'alipay' && amountMicro >= MANUAL_RECHARGE_THRESHOLD_MICRO) {
      res.status(400).json({ error: { message: '100元及以上请使用大额人工充值', type: 'manual_recharge_required' } });
      return;
    }
    if (parsed.data.payment_method === 'manual' && amountMicro < MANUAL_RECHARGE_THRESHOLD_MICRO) {
      res.status(400).json({ error: { message: '人工充值仅用于100元及以上订单', type: 'manual_recharge_minimum' } });
      return;
    }
    const minMicro = Number(getSetting('minimum_recharge_micro') ?? 1_000_000);
    const maxMicro = Number(getSetting('maximum_recharge_micro') ?? 1_000_000_000_000);
    if (amountMicro < minMicro || amountMicro > maxMicro) { res.status(400).json({ error: { message: 'Recharge amount is outside configured limits', type: 'invalid_amount' } }); return; }

    const orderNo =
      createOrderNo();
    const paymentReference = parsed.data.payment_method === 'manual' ? createPaymentReference() : null;

    const db =
      getDb();

    const inserted =
      db.prepare(`
        INSERT INTO recharge_orders (
          order_no,
          user_id,
          amount_micro,
          status,
          payment_method,
           payment_provider,
           payment_reference,
           expires_at
        )
        VALUES (
          ?,
          ?,
          ?,
          'pending',
           ?,
           NULL,
           ?,
           datetime(
             'now',
             ?
          )
        )
      `).run(
        orderNo,
        userId,
        amountMicro,
         parsed.data
           .payment_method,
         paymentReference,
         parsed.data.payment_method === 'manual' ? '+24 hours' : '+30 minutes',
      );

    res.status(201).json({
      order: {
        id:
          Number(
            inserted.lastInsertRowid,
          ),

        order_no:
          orderNo,

        amount:
          microToYuan(
            amountMicro,
          ),

        status:
          'pending',

         payment_method:
          parsed.data
             .payment_method,
         payment_reference: paymentReference,

        expires_in_minutes:
          parsed.data.payment_method === 'manual' ? 1440 : 30,
      },
    });
  },
);

userRechargeRouter.get('/manual-config', (_req, res) => {
  res.json({
    threshold: MANUAL_RECHARGE_THRESHOLD_MICRO / 1_000_000,
    qr_image: getSetting('manual_recharge_qr_image') ?? '',
    instructions: '付款时必须填写订单提供的唯一备注码，付款后上传清晰截图。管理员核对实际到账后充值。',
  });
});

userRechargeRouter.post('/orders/:id/proof', proofUpload.single('proof'), (req, res) => {
  const orderId = Number(req.params.id);
  const userId = getUserId(req);
  if (!req.file) { res.status(400).json({ error: { message: '请选择 JPG、PNG 或 WebP 付款截图', type: 'proof_required' } }); return; }
  const result = getDb().prepare(`UPDATE recharge_orders SET payment_proof=?, payment_proof_mime=?,
    proof_submitted_at=datetime('now'), updated_at=datetime('now')
    WHERE id=? AND user_id=? AND status='pending' AND payment_method='manual'`)
    .run(req.file.buffer, req.file.mimetype, orderId, userId);
  if (result.changes !== 1) { res.status(409).json({ error: { message: '订单不存在或当前状态不能提交凭证', type: 'invalid_order_state' } }); return; }
  res.json({ submitted: true });
});

/** Create an Alipay page-payment form for an existing order. */
userRechargeRouter.post('/orders/:id/alipay', (req, res) => {
  if (!isAlipayConfigured()) { res.status(503).json({ error: { message: 'Alipay is not configured', type: 'payment_unavailable' } }); return; }
  const orderId = Number(req.params.id);
  const userId = getUserId(req);
  const order = getDb().prepare("SELECT id, order_no orderNo, amount_micro amountMicro, status, payment_method paymentMethod FROM recharge_orders WHERE id=? AND user_id=?").get(orderId, userId) as { id:number; orderNo:string; amountMicro:number; status:string; paymentMethod:string|null } | undefined;
  if (!order) { res.status(404).json({ error: { message: 'Recharge order not found', type: 'not_found' } }); return; }
  if (order.status !== 'pending') { res.status(409).json({ error: { message: `Order is ${order.status}`, type: 'invalid_order_state' } }); return; }
  if (order.paymentMethod === 'manual') { res.status(409).json({ error: { message: '人工充值订单不能发起支付宝支付', type: 'invalid_payment_method' } }); return; }
  const payment = createPagePayment(order.orderNo, order.amountMicro, `FreeLLMAPI 充值 ${order.orderNo}`);
  getDb().prepare("UPDATE recharge_orders SET payment_provider='alipay', payment_method='alipay_page', updated_at=datetime('now') WHERE id=?").run(order.id);
  res.json({ order_no: order.orderNo, mode: 'page', gateway: payment.gateway, params: payment.params, form_action: payment.gateway });
});

/**
 * GET /api/user/recharge/orders
 *
 * List current user's recharge orders.
 */
userRechargeRouter.get(
  '/orders',
  (req, res) => {
    expireRechargeOrders();
    const userId =
      getUserId(req);

    const rows =
      getDb()
        .prepare(`
          SELECT
            id,

            order_no AS orderNo,

            amount_micro
              AS amountMicro,

            status,

            payment_method
              AS paymentMethod,

            payment_provider
              AS paymentProvider,

            provider_trade_no
              AS providerTradeNo,

             note,
             payment_reference AS paymentReference,
             proof_submitted_at AS proofSubmittedAt,

            created_at
              AS createdAt,

            updated_at
              AS updatedAt,

            expires_at
              AS expiresAt,

            paid_at
              AS paidAt

          FROM recharge_orders

          WHERE user_id = ?

          ORDER BY id DESC

          LIMIT 100
        `)
        .all(
          userId,
        ) as Array<{
          id: number;
          orderNo: string;
          amountMicro: number;
          status: string;
          paymentMethod:
            | string
            | null;
          paymentProvider:
            | string
            | null;
          providerTradeNo:
            | string
            | null;
           note:
            | string
             | null;
          paymentReference: string | null;
          proofSubmittedAt: string | null;
          createdAt: string;
          updatedAt: string;
          expiresAt:
            | string
            | null;
          paidAt:
            | string
            | null;
        }>;

    res.json({
      orders:
        rows.map(
          (row) => ({
            id:
              row.id,

            order_no:
              row.orderNo,

            amount:
              microToYuan(
                row.amountMicro,
              ),

            status:
              row.status,

            payment_method:
              row.paymentMethod,

            payment_provider:
              row.paymentProvider,

            provider_trade_no:
              row.providerTradeNo,

           note:
             row.note,
           payment_reference: row.paymentReference,
           proof_submitted_at: row.proofSubmittedAt,

            created_at:
              row.createdAt,

            updated_at:
              row.updatedAt,

            expires_at:
              row.expiresAt,

            paid_at:
              row.paidAt,
          }),
        ),
    });
  },
);

/**
 * POST /api/user/recharge/orders/:id/cancel
 *
 * User may cancel only their own pending order.
 */
userRechargeRouter.post(
  '/orders/:id/cancel',
  (req, res) => {
    const userId =
      getUserId(req);

    const orderId =
      Number(
        req.params.id,
      );

    if (
      !Number.isInteger(
        orderId,
      ) ||
      orderId <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid order id',

          type:
            'invalid_request',
        },
      });

      return;
    }

    const updated =
      getDb()
        .prepare(`
          UPDATE recharge_orders

          SET
            status = 'cancelled',
            updated_at =
              datetime('now')

          WHERE id = ?
            AND user_id = ?
            AND status = 'pending'
        `)
        .run(
          orderId,
          userId,
        );

    if (
      updated.changes !==
      1
    ) {
      res.status(409).json({
        error: {
          message:
            'Order cannot be cancelled',

          type:
            'invalid_order_state',
        },
      });

      return;
    }

    res.json({
      success: true,
    });
  },
);

/*
 * ==========================================================
 * ADMIN
 * ==========================================================
 */

adminRechargeRouter.post('/manual-config/qr', proofUpload.single('qr'), (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: '请选择 JPG、PNG 或 WebP 收款二维码', type: 'qr_required' } }); return; }
  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  setSetting('manual_recharge_qr_image', dataUrl);
  res.json({ configured: true });
});

adminRechargeRouter.get('/orders/:id/proof', (req, res) => {
  const row = getDb().prepare(`SELECT payment_proof proof, payment_proof_mime mime
    FROM recharge_orders WHERE id=? AND payment_proof IS NOT NULL`).get(Number(req.params.id)) as
    { proof: Buffer; mime: string } | undefined;
  if (!row) { res.status(404).json({ error: { message: '付款凭证不存在', type: 'not_found' } }); return; }
  res.json({ image: `data:${row.mime};base64,${row.proof.toString('base64')}` });
});

/**
 * GET /api/admin/recharge/orders
 *
 * Admin recharge-order management.
 */
adminRechargeRouter.get(
  '/orders',
  (req, res) => {
    expireRechargeOrders();
    const q =
      typeof req.query.q ===
      'string'
        ? req.query.q.trim()
        : '';

    const status =
      typeof req.query.status ===
      'string'
        ? req.query.status.trim()
        : '';

    const db =
      getDb();

    const rows =
      db.prepare(`
        SELECT
          ro.id,

          ro.order_no
            AS orderNo,

          ro.user_id
            AS userId,

          u.email,

          ro.amount_micro
            AS amountMicro,

          ro.status,

          ro.payment_method
            AS paymentMethod,

          ro.payment_provider
            AS paymentProvider,

          ro.provider_trade_no
            AS providerTradeNo,

          ro.note,
          ro.payment_reference AS paymentReference,
          ro.proof_submitted_at AS proofSubmittedAt,

          ro.created_at
            AS createdAt,

          ro.updated_at
            AS updatedAt,

          ro.expires_at
            AS expiresAt,

          ro.paid_at
            AS paidAt

        FROM recharge_orders ro

        JOIN users u
          ON u.id = ro.user_id

        WHERE (
          ? = ''
          OR ro.order_no LIKE '%' || ? || '%'
          OR u.email LIKE '%' || ? || '%'
        )

        AND (
          ? = ''
          OR ro.status = ?
        )

        ORDER BY ro.id DESC

        LIMIT 500
      `).all(
        q,
        q,
        q,
        status,
        status,
      ) as Array<{
        id: number;
        orderNo: string;
        userId: number;
        email: string;
        amountMicro: number;
        status: string;
        paymentMethod:
          | string
          | null;
        paymentProvider:
          | string
          | null;
        providerTradeNo:
          | string
          | null;
        note:
          | string
          | null;
        paymentReference: string | null;
        proofSubmittedAt: string | null;
        createdAt: string;
        updatedAt: string;
        expiresAt:
          | string
          | null;
        paidAt:
          | string
          | null;
      }>;

    res.json({
      orders:
        rows.map(
          (row) => ({
            id:
              row.id,

            order_no:
              row.orderNo,

            user_id:
              row.userId,

            email:
              row.email,

            amount:
              microToYuan(
                row.amountMicro,
              ),

            status:
              row.status,

            payment_method:
              row.paymentMethod,

            payment_provider:
              row.paymentProvider,

            provider_trade_no:
              row.providerTradeNo,

            note:
              row.note,
            payment_reference: row.paymentReference,
            proof_submitted_at: row.proofSubmittedAt,

            created_at:
              row.createdAt,

            updated_at:
              row.updatedAt,

            expires_at:
              row.expiresAt,

            paid_at:
              row.paidAt,
          }),
        ),
    });
  },
);

/**
 * POST /api/admin/recharge/orders/:id/mark-paid
 *
 * Atomic and idempotent recharge settlement.
 */
adminRechargeRouter.post(
  '/orders/:id/mark-paid',
  (req, res) => {
    const orderId =
      Number(
        req.params.id,
      );

    if (
      !Number.isInteger(
        orderId,
      ) ||
      orderId <= 0
    ) {
      res.status(400).json({
        error: {
          message:
            'Invalid order id',

          type:
            'invalid_request',
        },
      });

      return;
    }

    const parsed =
      markPaidSchema.safeParse(
        req.body ?? {},
      );

    if (!parsed.success) {
      res.status(400).json({
        error: {
          message:
            'Invalid request',

          type:
            'invalid_request',
        },
      });

      return;
    }

    const db =
      getDb();

    try {
      const settle =
        db.transaction(() => {
          const order =
            db.prepare(`
              SELECT
                id,

                order_no
                  AS orderNo,

                user_id
                  AS userId,

                amount_micro
                  AS amountMicro,

                status
                , payment_method AS paymentMethod
                , proof_submitted_at AS proofSubmittedAt

              FROM recharge_orders

              WHERE id = ?
            `).get(
              orderId,
            ) as
              | {
                  id: number;
                  orderNo: string;
                  userId: number;
                  amountMicro: number;
                  status: string;
                  paymentMethod: string | null;
                  proofSubmittedAt: string | null;
                }
              | undefined;

          if (!order) {
            return {
              status:
                'not_found' as const,
            };
          }

          /*
           * Idempotency:
           * already-paid order can never credit
           * the wallet a second time.
           */
          if (
            order.status ===
            'paid'
          ) {
            const wallet =
              db.prepare(`
                SELECT
                  balance_micro
                    AS balanceMicro

                FROM users

                WHERE id = ?
              `).get(
                order.userId,
              ) as
                | {
                    balanceMicro:
                      number;
                  }
                | undefined;

            return {
              status: 'already_paid' as const,

              orderNo:
                order.orderNo,

              balanceMicro:
                wallet
                  ?.balanceMicro ??
                0,
            };
          }

          if (
            order.status !==
            'pending'
          ) {
            return {
              status: 'invalid_state' as const,

              currentStatus:
                order.status,
            };
          }
          if (order.paymentMethod === 'manual' && !order.proofSubmittedAt) {
            return { status: 'proof_required' as const };
          }

          const user =
            db.prepare(`
              SELECT
                id,

                balance_micro
                  AS balanceMicro

              FROM users

              WHERE id = ?
            `).get(
              order.userId,
            ) as
              | {
                  id: number;
                  balanceMicro:
                    number;
                }
              | undefined;

          if (!user) {
            throw new Error(
              'Recharge order user not found',
            );
          }

          const balanceAfterMicro =
            user.balanceMicro +
            order.amountMicro;

          if (
            !Number.isSafeInteger(
              balanceAfterMicro,
            )
          ) {
            throw new Error(
              'Wallet balance exceeds safe integer range',
            );
          }

          /*
           * Mark paid first inside the same transaction.
           * WHERE status=pending prevents concurrent
           * double settlement.
           */
          const paid =
            db.prepare(`
              UPDATE recharge_orders

              SET
                status = 'paid',

                payment_provider =
                  COALESCE(
                    payment_provider,
                    'manual'
                  ),

                provider_trade_no = ?,

                note =
                  COALESCE(
                    ?,
                    note
                  ),

                paid_at =
                  datetime('now'),

                updated_at =
                  datetime('now')

              WHERE id = ?
                AND status = 'pending'
            `).run(
              parsed.data
                .provider_trade_no ??
                null,

              parsed.data.note ??
                null,

              order.id,
            );

          if (
            paid.changes !==
            1
          ) {
            throw new Error(
              'Recharge order state changed during settlement',
            );
          }

          db.prepare(`
            UPDATE users

            SET
              balance_micro = ?

            WHERE id = ?
          `).run(
            balanceAfterMicro,
            order.userId,
          );

          activateRechargedFreeTier(
            db,
            order.userId,
            order.amountMicro,
          );

          db.prepare(`
            INSERT INTO wallet_transactions (
              user_id,

              type,

              delta_micro,
              balance_after_micro,

              note
            )

            VALUES (
              ?,
              'recharge',
              ?,
              ?,
              ?
            )
          `).run(
            order.userId,

            order.amountMicro,

            balanceAfterMicro,

            `Recharge order ${order.orderNo}`,
          );

          return {
            status:
              'paid' as const,

            orderNo:
              order.orderNo,

            amountMicro:
              order.amountMicro,

            balanceAfterMicro,
          };
        });

      const result =
        settle();

      if (
        result.status ===
        'not_found'
      ) {
        res.status(404).json({
          error: {
            message:
              'Recharge order not found',

            type:
              'not_found',
          },
        });

        return;
      }

      if (
        result.status ===
        'invalid_state'
      ) {
        res.status(409).json({
          error: {
            message:
              `Order is ${result.currentStatus}`,

            type:
              'invalid_order_state',
          },
        });

        return;
      }

      if (
        result.status ===
        'already_paid'
      ) {
        res.json({
          success: true,

          already_paid: true,

          order_no:
            result.orderNo,

          balance:
            microToYuan(
              result.balanceMicro,
            ),
        });

        return;
      }

      if (result.status === 'proof_required') {
        res.status(409).json({ error: { message: '人工充值订单必须先提交付款凭证', type: 'proof_required' } });
        return;
      }

      res.json({
        success: true,

        already_paid: false,

        order_no:
          result.orderNo,

        amount:
          microToYuan(
            result.amountMicro,
          ),

        balance_after:
          microToYuan(
            result.balanceAfterMicro,
          ),
      });
    } catch (error) {
      console.error(
        '[Recharge] Settlement failed:',
        error,
      );

      res.status(500).json({
        error: {
          message:
            'Failed to settle recharge order',

          type:
            'internal_error',
        },
      });
    }
  },
);
