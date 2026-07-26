import type { Db } from '../db/types.js';

import {
  calculateBillingAmountMicro,
  getModelBillingRule,
} from './billing.js';

export type ReservedChargeResult =
  | {
      status: 'charged';
      amountMicro: number;
      balanceAfterMicro: number;
    }
  | {
      status: 'free';
      amountMicro: 0;
      balanceAfterMicro: number;
    }
  | {
      status:
        | 'already_processed'
        | 'not_billable'
        | 'no_billing_rule'
        | 'insufficient_balance'
        | 'request_not_found'
        | 'reservation_not_found'
        | 'reservation_already_finalized';
      amountMicro?: number;
      balanceAfterMicro?: number;
    };

interface RequestRow {
  id: number;
  platform: string;
  modelId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  consumerUserId: number | null;
  billingStatus:
    | 'unbilled'
    | 'charged'
    | 'free'
    | 'exempt';
}

interface ReservationRow {
  id: number;
  userId: number;
  reservedMicro: number;
  status:
    | 'reserved'
    | 'settled'
    | 'released'
    | 'failed';
}

interface WalletRow {
  balanceMicro: number;
  reservedBalanceMicro: number;
}

function markRequestExempt(
  db: Db,
  requestId: number,
): void {
  db.prepare(`
    UPDATE requests
    SET
      billing_status = 'exempt',
      billing_amount_micro = 0
    WHERE id = ?
      AND billing_status = 'unbilled'
  `).run(requestId);
}

export function chargeReservedRequest(
  db: Db,
  requestId: number,
  reservationId: number,
): ReservedChargeResult {
  const transaction =
    db.transaction(
      (): ReservedChargeResult => {
        const request =
          db.prepare(`
            SELECT
              id,
              platform,
              model_id AS modelId,
              status,
              input_tokens AS inputTokens,
              output_tokens AS outputTokens,
              consumer_user_id AS consumerUserId,
              billing_status AS billingStatus
            FROM requests
            WHERE id = ?
          `).get(requestId) as
            | RequestRow
            | undefined;

        if (!request) {
          return {
            status: 'request_not_found',
          };
        }

        if (
          request.billingStatus !==
          'unbilled'
        ) {
          return {
            status: 'already_processed',
          };
        }

        // Failed routing attempts are not charged.
        // Do not release the reservation here because
        // failover may still succeed on another route.
        if (
          request.status !==
          'success'
        ) {
          markRequestExempt(
            db,
            request.id,
          );

          return {
            status: 'not_billable',
          };
        }

        if (
          request.consumerUserId ===
          null
        ) {
          markRequestExempt(
            db,
            request.id,
          );

          return {
            status: 'not_billable',
          };
        }

        const reservation =
          db.prepare(`
            SELECT
              id,
              user_id AS userId,
              reserved_micro AS reservedMicro,
              status
            FROM wallet_reservations
            WHERE id = ?
          `).get(
            reservationId,
          ) as
            | ReservationRow
            | undefined;

        if (!reservation) {
          return {
            status:
              'reservation_not_found',
          };
        }

        if (
          reservation.status !==
          'reserved'
        ) {
          return {
            status:
              'reservation_already_finalized',
          };
        }

        if (
          reservation.userId !==
          request.consumerUserId
        ) {
          throw new Error(
            'Wallet reservation user does not match request user',
          );
        }

        const rule =
          getModelBillingRule(
            db,
            request.platform,
            request.modelId,
          );

        if (
          !rule ||
          !rule.billingEnabled
        ) {
          return {
            status:
              'no_billing_rule',
          };
        }

        const amountMicro =
          calculateBillingAmountMicro(
            request.inputTokens,
            request.outputTokens,
            rule.inputPriceMicroPerMillion,
            rule.outputPriceMicroPerMillion,
            rule.multiplierMilli,
          );

        const wallet =
          db.prepare(`
            SELECT
              balance_micro AS balanceMicro,
              reserved_balance_micro
                AS reservedBalanceMicro
            FROM users
            WHERE id = ?
          `).get(
            request.consumerUserId,
          ) as
            | WalletRow
            | undefined;

        if (!wallet) {
          return {
            status:
              'insufficient_balance',
            amountMicro,
            balanceAfterMicro: 0,
          };
        }

        // Explicit free model.
        if (
          amountMicro === 0
        ) {
          const released =
            db.prepare(`
              UPDATE users
              SET
                reserved_balance_micro =
                  reserved_balance_micro - ?
              WHERE id = ?
                AND reserved_balance_micro >= ?
            `).run(
              reservation.reservedMicro,
              request.consumerUserId,
              reservation.reservedMicro,
            );

          if (
            released.changes !== 1
          ) {
            throw new Error(
              'Failed to release free request reservation',
            );
          }

          const reservationUpdated =
            db.prepare(`
              UPDATE wallet_reservations
              SET
                request_id = ?,
                actual_micro = 0,
                status = 'settled',
                settled_at = datetime('now')
              WHERE id = ?
                AND status = 'reserved'
            `).run(
              request.id,
              reservation.id,
            );

          if (
            reservationUpdated.changes !==
            1
          ) {
            throw new Error(
              'Failed to settle free reservation',
            );
          }

          const requestUpdated =
            db.prepare(`
              UPDATE requests
              SET
                billing_amount_micro = 0,
                billing_status = 'free'
              WHERE id = ?
                AND billing_status = 'unbilled'
            `).run(
              request.id,
            );

          if (
            requestUpdated.changes !==
            1
          ) {
            throw new Error(
              'Failed to mark free request',
            );
          }

          return {
            status: 'free',
            amountMicro: 0,
            balanceAfterMicro:
              wallet.balanceMicro,
          };
        }

        // Money reserved for other simultaneous requests
        // must not be spent by this request.
        const otherReservedMicro =
          Math.max(
            0,
            wallet.reservedBalanceMicro -
              reservation.reservedMicro,
          );

        const spendableForThisRequest =
          Math.max(
            0,
            wallet.balanceMicro -
              otherReservedMicro,
          );

        // Admission is controlled only by the fixed minimum wallet balance.
        // If actual usage costs more than remains after the request, collect
        // the spendable balance without allowing the wallet to become negative.
        const chargedMicro =
          Math.min(
            amountMicro,
            spendableForThisRequest,
          );

        const balanceAfterMicro =
          wallet.balanceMicro -
          chargedMicro;

        // Deduct actual usage and release this
        // reservation atomically.
        const updated =
          db.prepare(`
            UPDATE users
            SET
              balance_micro =
                balance_micro - ?,
              reserved_balance_micro =
                reserved_balance_micro - ?
            WHERE id = ?
              AND reserved_balance_micro >= ?
              AND balance_micro >= ?
          `).run(
            chargedMicro,
            reservation.reservedMicro,
            request.consumerUserId,
            reservation.reservedMicro,
            chargedMicro,
          );

        if (
          updated.changes !== 1
        ) {
          return {
            status:
              'insufficient_balance',
            amountMicro,
          };
        }

        db.prepare(`
          INSERT INTO wallet_transactions (
            user_id,
            type,
            delta_micro,
            balance_after_micro,
            request_id,
            platform,
            model_id,
            input_tokens,
            output_tokens,
            multiplier_milli,
            input_price_micro_per_million,
            output_price_micro_per_million,
            note
          )
          VALUES (
            ?,
            'usage',
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `).run(
          request.consumerUserId,
          -chargedMicro,
          balanceAfterMicro,
          request.id,
          request.platform,
          request.modelId,
          request.inputTokens,
          request.outputTokens,
          rule.multiplierMilli,
          rule.inputPriceMicroPerMillion,
          rule.outputPriceMicroPerMillion,
          chargedMicro < amountMicro
            ? `API usage charge capped at available balance; calculated cost: ${amountMicro} micro`
            : 'API usage charge',
        );

        const markedRequest =
          db.prepare(`
            UPDATE requests
            SET
              billing_amount_micro = ?,
              billing_status = 'charged'
            WHERE id = ?
              AND billing_status = 'unbilled'
          `).run(
            chargedMicro,
            request.id,
          );

        if (
          markedRequest.changes !==
          1
        ) {
          throw new Error(
            'Request billing state changed during reservation settlement',
          );
        }

        const markedReservation =
          db.prepare(`
            UPDATE wallet_reservations
            SET
              request_id = ?,
              actual_micro = ?,
              status = 'settled',
              settled_at = datetime('now')
            WHERE id = ?
              AND status = 'reserved'
          `).run(
            request.id,
            chargedMicro,
            reservation.id,
          );

        if (
          markedReservation.changes !==
          1
        ) {
          throw new Error(
            'Reservation state changed during settlement',
          );
        }

        return {
          status: 'charged',
          amountMicro: chargedMicro,
          balanceAfterMicro,
        };
      },
    );

  return transaction();
}
