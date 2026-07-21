import type { Db } from '../db/types.js';

export interface WalletReservation {
  id: number;
  userId: number;
  consumerApiKeyId: number | null;
  requestId: number | null;
  requestedModel: string | null;
  reservedMicro: number;
  actualMicro: number | null;
  status:
    | 'reserved'
    | 'settled'
    | 'released'
    | 'failed';
  createdAt: string;
  settledAt: string | null;
}

export type ReserveWalletResult =
  | {
      status: 'reserved';
      reservationId: number;
      reservedMicro: number;
      availableAfterMicro: number;
    }
  | {
      status: 'insufficient_balance';
      availableMicro: number;
    }
  | {
      status: 'user_not_found';
      availableMicro: 0;
    };

export type ReleaseReservationResult =
  | {
      status: 'released';
      releasedMicro: number;
    }
  | {
      status:
        | 'already_finalized'
        | 'reservation_not_found';
      releasedMicro: 0;
    };

interface WalletRow {
  balanceMicro: number;
  reservedBalanceMicro: number;
}

interface ReservationRow {
  id: number;
  userId: number;
  consumerApiKeyId: number | null;
  requestId: number | null;
  requestedModel: string | null;
  reservedMicro: number;
  actualMicro: number | null;
  status:
    | 'reserved'
    | 'settled'
    | 'released'
    | 'failed';
  createdAt: string;
  settledAt: string | null;
}

export function getAvailableBalanceMicro(
  db: Db,
  userId: number,
): number {
  const row =
    db.prepare(`
      SELECT
        balance_micro AS balanceMicro,
        reserved_balance_micro
          AS reservedBalanceMicro
      FROM users
      WHERE id = ?
    `).get(
      userId,
    ) as WalletRow | undefined;

  if (!row) {
    return 0;
  }

  return Math.max(
    0,
    row.balanceMicro -
      row.reservedBalanceMicro,
  );
}

/**
 * Atomically reserves part of a prepaid wallet.
 *
 * balance_micro stays unchanged.
 * reserved_balance_micro increases.
 *
 * Available balance:
 * balance_micro - reserved_balance_micro
 */
export function reserveWalletBalance(
  db: Db,
  userId: number,
  consumerApiKeyId: number | null,
  requestedModel: string | null,
  requestedReserveMicro: number,
): ReserveWalletResult {
  const reserveMicro =
    Math.max(
      1,
      Math.trunc(
        requestedReserveMicro,
      ),
    );

  if (
    !Number.isSafeInteger(
      reserveMicro,
    )
  ) {
    throw new Error(
      'Reservation amount exceeds safe integer range',
    );
  }

  const transaction =
    db.transaction(
      (): ReserveWalletResult => {
        const wallet =
          db.prepare(`
            SELECT
              balance_micro AS balanceMicro,
              reserved_balance_micro
                AS reservedBalanceMicro
            FROM users
            WHERE id = ?
          `).get(
            userId,
          ) as
            | WalletRow
            | undefined;

        if (!wallet) {
          return {
            status:
              'user_not_found',
            availableMicro: 0,
          };
        }

        const availableMicro =
          Math.max(
            0,
            wallet.balanceMicro -
              wallet.reservedBalanceMicro,
          );

        if (
          availableMicro <
          reserveMicro
        ) {
          return {
            status:
              'insufficient_balance',
            availableMicro,
          };
        }

        /*
         * Atomic concurrency guard.
         *
         * Two simultaneous requests cannot reserve
         * the same available wallet balance.
         */
        const updated =
          db.prepare(`
            UPDATE users
            SET
              reserved_balance_micro =
                reserved_balance_micro + ?
            WHERE id = ?
              AND (
                balance_micro -
                reserved_balance_micro
              ) >= ?
          `).run(
            reserveMicro,
            userId,
            reserveMicro,
          );

        if (
          updated.changes !== 1
        ) {
          const latestAvailable =
            getAvailableBalanceMicro(
              db,
              userId,
            );

          return {
            status:
              'insufficient_balance',
            availableMicro:
              latestAvailable,
          };
        }

        const inserted =
          db.prepare(`
            INSERT INTO wallet_reservations (
              user_id,
              consumer_api_key_id,
              requested_model,
              reserved_micro,
              status
            )
            VALUES (
              ?,
              ?,
              ?,
              ?,
              'reserved'
            )
          `).run(
            userId,
            consumerApiKeyId,
            requestedModel,
            reserveMicro,
          );

        return {
          status: 'reserved',

          reservationId:
            Number(
              inserted.lastInsertRowid,
            ),

          reservedMicro:
            reserveMicro,

          availableAfterMicro:
            availableMicro -
            reserveMicro,
        };
      },
    );

  return transaction();
}

/**
 * Releases a reservation without charging the user.
 *
 * Used when:
 * - request is rejected before provider usage
 * - all provider attempts fail
 * - connection closes before successful settlement
 */
export function releaseWalletReservation(
  db: Db,
  reservationId: number,
  finalStatus:
    | 'released'
    | 'failed' = 'released',
): ReleaseReservationResult {
  const transaction =
    db.transaction(
      (): ReleaseReservationResult => {
        const reservation =
          db.prepare(`
            SELECT
              id,
              user_id AS userId,
              reserved_micro
                AS reservedMicro,
              status
            FROM wallet_reservations
            WHERE id = ?
          `).get(
            reservationId,
          ) as
            | {
                id: number;
                userId: number;
                reservedMicro: number;
                status: string;
              }
            | undefined;

        if (!reservation) {
          return {
            status:
              'reservation_not_found',
            releasedMicro: 0,
          };
        }

        /*
         * Idempotent:
         * finish + close may both fire.
         */
        if (
          reservation.status !==
          'reserved'
        ) {
          return {
            status:
              'already_finalized',
            releasedMicro: 0,
          };
        }

        db.prepare(`
          UPDATE users
          SET
            reserved_balance_micro =
              CASE
                WHEN reserved_balance_micro >= ?
                THEN
                  reserved_balance_micro - ?
                ELSE 0
              END
          WHERE id = ?
        `).run(
          reservation.reservedMicro,
          reservation.reservedMicro,
          reservation.userId,
        );

        const updated =
          db.prepare(`
            UPDATE wallet_reservations
            SET
              status = ?,
              settled_at =
                datetime('now')
            WHERE id = ?
              AND status = 'reserved'
          `).run(
            finalStatus,
            reservation.id,
          );

        if (
          updated.changes !== 1
        ) {
          throw new Error(
            'Reservation state changed during release',
          );
        }

        return {
          status: 'released',
          releasedMicro:
            reservation.reservedMicro,
        };
      },
    );

  return transaction();
}

export function getWalletReservation(
  db: Db,
  reservationId: number,
): WalletReservation | null {
  const row =
    db.prepare(`
      SELECT
        id,
        user_id AS userId,
        consumer_api_key_id
          AS consumerApiKeyId,
        request_id AS requestId,
        requested_model
          AS requestedModel,
        reserved_micro
          AS reservedMicro,
        actual_micro AS actualMicro,
        status,
        created_at AS createdAt,
        settled_at AS settledAt
      FROM wallet_reservations
      WHERE id = ?
    `).get(
      reservationId,
    ) as
      | ReservationRow
      | undefined;

  return row ?? null;
}