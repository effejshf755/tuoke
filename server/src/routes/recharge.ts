import { randomUUID } from 'crypto';

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import { getSetting } from '../db/index.js';

export const userRechargeRouter =
  Router();

export const adminRechargeRouter =
  Router();

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
    const minMicro = Number(getSetting('minimum_recharge_micro') ?? 1_000_000);
    const maxMicro = Number(getSetting('maximum_recharge_micro') ?? 1_000_000_000_000);
    if (amountMicro < minMicro || amountMicro > maxMicro) { res.status(400).json({ error: { message: 'Recharge amount is outside configured limits', type: 'invalid_amount' } }); return; }

    const orderNo =
      createOrderNo();

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
          expires_at
        )
        VALUES (
          ?,
          ?,
          ?,
          'pending',
          ?,
          NULL,
          datetime(
            'now',
            '+30 minutes'
          )
        )
      `).run(
        orderNo,
        userId,
        amountMicro,
        parsed.data
          .payment_method,
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

        expires_in_minutes:
          30,
      },
    });
  },
);

/**
 * GET /api/user/recharge/orders
 *
 * List current user's recharge orders.
 */
userRechargeRouter.get(
  '/orders',
  (req, res) => {
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

/**
 * GET /api/admin/recharge/orders
 *
 * Admin recharge-order management.
 */
adminRechargeRouter.get(
  '/orders',
  (req, res) => {
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
