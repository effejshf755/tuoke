import type { Db } from '../db/types.js';

export interface BillingRule {
  id: number;
  platform: string;
  modelId: string;
  inputPriceMicroPerMillion: number;
  outputPriceMicroPerMillion: number;
  multiplierMilli: number;
  billingEnabled: 0 | 1;
}

export interface WalletSummary {
  userId: number;
  balanceMicro: number;
}

export type ChargeResult =
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
        | 'request_not_found';
      amountMicro?: number;
      balanceAfterMicro?: number;
    };

interface RequestBillingRow {
  id: number;
  platform: string;
  modelId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  consumerUserId: number | null;
  billingAmountMicro: number;
  billingStatus:
    | 'unbilled'
    | 'charged'
    | 'free'
    | 'exempt';
}

export function getUserWallet(
  db: Db,
  userId: number,
): WalletSummary | null {
  const row = db.prepare(`
    SELECT
      id AS userId,
      balance_micro AS balanceMicro
    FROM users
    WHERE id = ?
  `).get(userId) as WalletSummary | undefined;

  return row ?? null;
}

export function getModelBillingRule(
  db: Db,
  platform: string,
  modelId: string,
): BillingRule | null {
  const row = db.prepare(`
    SELECT
      id,
      platform,
      model_id AS modelId,
      input_price_micro_per_million
        AS inputPriceMicroPerMillion,
      output_price_micro_per_million
        AS outputPriceMicroPerMillion,
      multiplier_milli
        AS multiplierMilli,
      billing_enabled
        AS billingEnabled
    FROM model_billing_rules
    WHERE platform = ?
      AND model_id = ?
    LIMIT 1
  `).get(
    platform,
    modelId,
  ) as BillingRule | undefined;

  return row ?? null;
}

/**
 * 精确计算一次模型请求费用。
 *
 * 金额单位：
 * 1 元 = 1,000,000 micro
 *
 * 模型价格单位：
 * micro / 1,000,000 tokens
 *
 * 倍率：
 * 1000 = 1x
 * 1500 = 1.5x
 * 2000 = 2x
 *
 * 最终结果向上取整到 1 micro，
 * 避免极小调用因为整数除法变成 0 元。
 */
export function calculateBillingAmountMicro(
  inputTokens: number,
  outputTokens: number,
  inputPriceMicroPerMillion: number,
  outputPriceMicroPerMillion: number,
  multiplierMilli: number,
): number {
  const safeInputTokens =
    Math.max(
      0,
      Math.trunc(inputTokens),
    );

  const safeOutputTokens =
    Math.max(
      0,
      Math.trunc(outputTokens),
    );

  const safeInputPrice =
    Math.max(
      0,
      Math.trunc(
        inputPriceMicroPerMillion,
      ),
    );

  const safeOutputPrice =
    Math.max(
      0,
      Math.trunc(
        outputPriceMicroPerMillion,
      ),
    );

  const safeMultiplier =
    Math.max(
      0,
      Math.trunc(multiplierMilli),
    );

  const raw =
    BigInt(safeInputTokens) *
      BigInt(safeInputPrice)
    +
    BigInt(safeOutputTokens) *
      BigInt(safeOutputPrice);

  if (
    raw === 0n ||
    safeMultiplier === 0
  ) {
    return 0;
  }

  /*
   * raw:
   * token × micro-per-million
   *
   * 再乘 multiplierMilli。
   *
   * 分母：
   * 1,000,000 tokens
   * × 1,000 multiplier scale
   * = 1,000,000,000
   */
  const numerator =
    raw *
    BigInt(safeMultiplier);

  const denominator =
    1_000_000_000n;

  const roundedUp =
    (
      numerator +
      denominator -
      1n
    ) /
    denominator;

  if (
    roundedUp >
    BigInt(
      Number.MAX_SAFE_INTEGER,
    )
  ) {
    throw new Error(
      'Billing amount exceeds safe integer range',
    );
  }

  return Number(
    roundedUp,
  );
}

/**
 * 根据 request_id 对一次请求进行结算。
 *
 * 重要：
 * - 只对 success 请求收费
 * - 系统/管理员非消费者请求不收费
 * - 使用实际 platform + model_id
 * - 使用实际 input/output tokens
 * - 已结算请求不会重复收费
 * - 扣余额、写流水、更新 requests 在同一事务完成
 */
export function chargeRequest(
  db: Db,
  requestId: number,
): ChargeResult {
  const transaction =
    db.transaction(
      (): ChargeResult => {
        const request =
          db.prepare(`
            SELECT
              id,
              platform,
              model_id AS modelId,
              status,
              input_tokens AS inputTokens,
              output_tokens AS outputTokens,
              consumer_user_id
                AS consumerUserId,
              billing_amount_micro
                AS billingAmountMicro,
              billing_status
                AS billingStatus
            FROM requests
            WHERE id = ?
          `).get(
            requestId,
          ) as
            | RequestBillingRow
            | undefined;

        if (!request) {
          return {
            status:
              'request_not_found',
          };
        }

        if (
          request.billingStatus !==
          'unbilled'
        ) {
          return {
            status:
              'already_processed',
          };
        }

        /*
         * 请求失败不收费。
         */
        if (
          request.status !==
          'success'
        ) {
          db.prepare(`
            UPDATE requests
            SET
              billing_status =
                'exempt',
              billing_amount_micro = 0
            WHERE id = ?
              AND billing_status =
                'unbilled'
          `).run(
            request.id,
          );

          return {
            status:
              'not_billable',
          };
        }

        /*
         * 没有消费者用户身份：
         * 例如管理员内部调用、
         * 系统调用或全局统一 Key。
         */
        if (
          request.consumerUserId ===
          null
        ) {
          db.prepare(`
            UPDATE requests
            SET
              billing_status =
                'exempt',
              billing_amount_micro = 0
            WHERE id = ?
              AND billing_status =
                'unbilled'
          `).run(
            request.id,
          );

          return {
            status:
              'not_billable',
          };
        }

        const rule =
          getModelBillingRule(
            db,
            request.platform,
            request.modelId,
          );

        /*
         * 没有设置计费规则时，
         * 绝不能偷偷按免费处理。
         *
         * 保持 unbilled，
         * 后续调用前拦截会禁止
         * 未配置价格的模型。
         */
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
          getUserWallet(
            db,
            request.consumerUserId,
          );

        if (!wallet) {
          return {
            status:
              'insufficient_balance',
            amountMicro,
            balanceAfterMicro: 0,
          };
        }

        /*
         * 管理员可以显式把某模型价格设为 0，
         * 这种请求记录为 free。
         */
        if (amountMicro === 0) {
          db.prepare(`
            UPDATE requests
            SET
              billing_status =
                'free',
              billing_amount_micro = 0
            WHERE id = ?
              AND billing_status =
                'unbilled'
          `).run(
            request.id,
          );

          return {
            status: 'free',
            amountMicro: 0,
            balanceAfterMicro:
              wallet.balanceMicro,
          };
        }

        /*
         * 余额不足时绝不允许变成负数。
         *
         * 当前先返回 insufficient_balance。
         * 后续我们会在请求进入模型之前
         * 增加预付余额检查，
         * 避免请求已经完成才发现钱不够。
         */
        if (
          wallet.balanceMicro <
          amountMicro
        ) {
          return {
            status:
              'insufficient_balance',
            amountMicro,
            balanceAfterMicro:
              wallet.balanceMicro,
          };
        }

        const balanceAfterMicro =
          wallet.balanceMicro -
          amountMicro;

        const updated =
          db.prepare(`
            UPDATE users
            SET
              balance_micro =
                balance_micro - ?
            WHERE id = ?
              AND balance_micro >= ?
          `).run(
            amountMicro,
            request.consumerUserId,
            amountMicro,
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

        /*
         * 保存完整价格快照。
         *
         * 以后管理员修改价格或倍率，
         * 历史账单仍保持原始计费数据。
         */
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
          -amountMicro,
          balanceAfterMicro,
          request.id,
          request.platform,
          request.modelId,
          request.inputTokens,
          request.outputTokens,
          rule.multiplierMilli,
          rule.inputPriceMicroPerMillion,
          rule.outputPriceMicroPerMillion,
          'API usage charge',
        );

        const marked =
          db.prepare(`
            UPDATE requests
            SET
              billing_amount_micro = ?,
              billing_status =
                'charged'
            WHERE id = ?
              AND billing_status =
                'unbilled'
          `).run(
            amountMicro,
            request.id,
          );

        if (
          marked.changes !== 1
        ) {
          throw new Error(
            'Request billing state changed during settlement',
          );
        }

        return {
          status: 'charged',
          amountMicro,
          balanceAfterMicro,
        };
      },
    );

  return transaction();
}