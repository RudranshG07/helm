import { idempotencyKey, orderReceipt } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import type { PoolClient } from 'pg';
import { config } from './config.ts';
import { DuplicateReceiptError } from './gateway.ts';
import type { Gateway, PaymentRef } from './gateway.ts';
import { log } from './log.ts';

export type CrashPoint =
  | 'after_intent'
  | 'before_gateway'
  | 'after_gateway'
  | 'before_settle'
  | null;

export interface ExecutionRequest {
  decision_id: number | null;
  subscription_id: string;
  rzp_subscription_id: string;
  cycle: Date;
  attempt_number: number;
  amount_paise: number;
  scheduled_for: Date;
}

export type ExecutionResult =
  | { status: 'executed'; key: string; order_id: string; payment: PaymentRef | null }
  | { status: 'dry_run'; key: string }
  | { status: 'duplicate'; key: string }
  | { status: 'reconciled'; key: string; order_id: string }
  | { status: 'blocked'; key: string; reason: string };

class SimulatedCrash extends Error {
  constructor(point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export interface ExecutorOptions {
  gateway: Gateway;
  dryRun?: boolean;
  crashAt?: CrashPoint;
}

async function guardsPassed(client: PoolClient, subscriptionId: string): Promise<string | null> {
  const { rows } = await client.query<{ kill_switch: boolean; write_enabled: boolean }>(
    `SELECT c.kill_switch, m.write_enabled
       FROM control_flags c
       CROSS JOIN subscription s
       JOIN merchant m ON m.id = s.merchant_id
      WHERE c.id = 1 AND s.id = $1`,
    [subscriptionId],
  );
  const row = rows[0];
  if (!row) return 'subscription not found';
  if (row.kill_switch) return 'kill switch engaged';
  if (!row.write_enabled) return 'merchant write access not granted';
  return null;
}

export async function execute(
  req: ExecutionRequest,
  options: ExecutorOptions,
): Promise<ExecutionResult> {
  const dryRun = options.dryRun ?? config.dryRun;
  const crashAt = options.crashAt ?? null;
  const key = idempotencyKey(req);
  const receipt = orderReceipt(req);

  const claimed = await withTransaction(async (client) => {
    const guard = await guardsPassed(client, req.subscription_id);
    if (guard) return { blocked: guard };

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO execution_intent (
         idempotency_key, subscription_id, cycle, attempt_number, decision_id,
         amount_paise, scheduled_for, state, dry_run
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        key, req.subscription_id, req.cycle, req.attempt_number, req.decision_id,
        req.amount_paise, req.scheduled_for, dryRun ? 'DRY_RUN' : 'INTENDED', dryRun,
      ],
    );
    return { blocked: null, inserted: rows.length > 0 };
  });

  if (claimed.blocked) {
    log.warn('executor.blocked', { key, reason: claimed.blocked });
    return { status: 'blocked', key, reason: claimed.blocked };
  }

  if (!claimed.inserted) {
    log.info('executor.duplicate_intent', { key });
    return { status: 'duplicate', key };
  }

  if (crashAt === 'after_intent') throw new SimulatedCrash(crashAt);

  if (dryRun) {
    log.info('executor.dry_run', { key, amount_paise: req.amount_paise });
    return { status: 'dry_run', key };
  }

  if (crashAt === 'before_gateway') throw new SimulatedCrash(crashAt);

  let order;
  let payment: PaymentRef | null = null;

  try {
    const result = await options.gateway.createOrderAndCharge({
      receipt,
      amount_paise: req.amount_paise,
      subscription_id: req.subscription_id,
      rzp_subscription_id: req.rzp_subscription_id,
      scheduled_for: req.scheduled_for,
    });
    order = result.order;
    payment = result.payment;
  } catch (err) {
    if (err instanceof DuplicateReceiptError) {
      log.warn('executor.receipt_already_used', { key });
      return reconcileOne(key, receipt, options.gateway);
    }
    await query(
      `UPDATE execution_intent SET last_error = $2 WHERE idempotency_key = $1`,
      [key, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  }

  if (crashAt === 'after_gateway') throw new SimulatedCrash(crashAt);

  await query(
    `UPDATE execution_intent
        SET state = 'SUBMITTED', rzp_order_id = $2, rzp_payment_id = $3, submitted_at = clock_timestamp()
      WHERE idempotency_key = $1`,
    [key, order.id, payment?.id ?? null],
  );

  if (crashAt === 'before_settle') throw new SimulatedCrash(crashAt);

  if (payment && (payment.status === 'captured' || payment.status === 'failed')) {
    await settle(key, payment);
  }

  log.info('executor.submitted', { key, order_id: order.id, payment_status: payment?.status ?? null });
  return { status: 'executed', key, order_id: order.id, payment };
}

async function settle(key: string, payment: PaymentRef): Promise<void> {
  await query(
    `UPDATE execution_intent
        SET state = $2, rzp_payment_id = $3, settled_at = clock_timestamp(), last_error = $4
      WHERE idempotency_key = $1`,
    [
      key,
      payment.status === 'captured' ? 'SETTLED_SUCCESS' : 'SETTLED_FAILED',
      payment.id,
      payment.error_reason ?? null,
    ],
  );
  await query(
    `UPDATE decision d
        SET executed_at = clock_timestamp(),
            outcome = $2
      FROM execution_intent i
      WHERE i.idempotency_key = $1 AND d.id = i.decision_id`,
    [key, payment.status === 'captured' ? 'recovered' : 'failed'],
  );
}

async function reconcileOne(key: string, receipt: string, gateway: Gateway): Promise<ExecutionResult> {
  const existing = await gateway.findOrderByReceipt(receipt);

  if (!existing) {
    await query(
      `UPDATE execution_intent SET state = 'ABANDONED', settled_at = clock_timestamp()
        WHERE idempotency_key = $1 AND state IN ('INTENDED','SUBMITTED')`,
      [key],
    );
    log.info('reconciler.abandoned', { key });
    return { status: 'reconciled', key, order_id: '' };
  }

  const settled = existing.payments.find((p) => p.status === 'captured' || p.status === 'failed');

  if (settled) {
    await query(
      `UPDATE execution_intent SET rzp_order_id = $2 WHERE idempotency_key = $1`,
      [key, existing.order.id],
    );
    await settle(key, settled);
  } else {
    await query(
      `UPDATE execution_intent
          SET state = 'SUBMITTED', rzp_order_id = $2, submitted_at = COALESCE(submitted_at, clock_timestamp())
        WHERE idempotency_key = $1`,
      [key, existing.order.id],
    );
  }

  log.info('reconciler.resolved', { key, order_id: existing.order.id, settled: Boolean(settled) });
  return { status: 'reconciled', key, order_id: existing.order.id };
}

export async function reconcileStuck(gateway: Gateway, olderThanMs = 5 * 60_000): Promise<number> {
  const { rows } = await query<{ idempotency_key: string; subscription_id: string; cycle: Date; attempt_number: number }>(
    `SELECT idempotency_key, subscription_id, cycle, attempt_number
       FROM execution_intent
      WHERE state IN ('INTENDED','SUBMITTED')
        AND dry_run = FALSE
        AND created_at < now() - ($1::int * interval '1 millisecond')
      ORDER BY created_at
      LIMIT 50`,
    [olderThanMs],
  );

  for (const row of rows) {
    const receipt = orderReceipt(row);
    try {
      await reconcileOne(row.idempotency_key, receipt, gateway);
    } catch (err) {
      log.error('reconciler.failed', {
        key: row.idempotency_key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rows.length;
}
