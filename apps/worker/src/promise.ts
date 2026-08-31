import { checkPromise, promiseAttemptTime, promiseReliability } from '@mandate/core';
import type { PromiseRecord } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { log } from './log.ts';

export interface RecordPromiseInput {
  subscription_id: string;
  outreach_id: string | null;
  promised_for: string;
  now?: Date;
  source?: 'customer' | 'merchant' | 'inferred';
}

export type RecordPromiseResult =
  | { ok: true; id: string; promised_for: string; attempt_at: Date; superseded: number }
  | { ok: false; error: string };

interface Target {
  cycle: Date;
  cycle_end: Date | null;
  amount_paise: string;
}

export async function recordPromise(input: RecordPromiseInput): Promise<RecordPromiseResult> {
  const now = input.now ?? new Date();

  const { rows } = await query<Target>(
    `SELECT COALESCE(s.current_start, date_trunc('month', now())) AS cycle,
            s.current_end, s.amount_paise::text AS amount_paise
       FROM subscription s WHERE s.id = $1`,
    [input.subscription_id],
  );
  const target = rows[0];
  if (!target) return { ok: false, error: 'That subscription no longer exists.' };

  const check = checkPromise({
    promised_for: input.promised_for,
    now,
    cycle_end: target.cycle_end,
  });
  if (!check.ok) return { ok: false, error: check.error };

  return withTransaction(async (client) => {
    const { rowCount: superseded } = await client.query(
      `UPDATE promise_to_pay
          SET status = 'superseded', resolved_at = clock_timestamp()
        WHERE subscription_id = $1 AND cycle = $2 AND status = 'open'`,
      [input.subscription_id, target.cycle],
    );

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO promise_to_pay (
         subscription_id, outreach_id, cycle, promised_for, amount_paise, status, source
       ) VALUES ($1,$2,$3,$4,$5,'open',$6)
       RETURNING id::text AS id`,
      [
        input.subscription_id, input.outreach_id, target.cycle, check.promised_for,
        Number(target.amount_paise), input.source ?? 'customer',
      ],
    );

    log.info('promise.recorded', {
      subscription_id: input.subscription_id,
      promised_for: check.promised_for,
      superseded: superseded ?? 0,
    });

    return {
      ok: true as const,
      id: created[0]!.id,
      promised_for: check.promised_for,
      attempt_at: check.attempt_at,
      superseded: superseded ?? 0,
    };
  });
}

export interface OpenPromise {
  id: string;
  subscription_id: string;
  cycle: Date;
  promised_for: string;
  attempt_at: Date;
}

export async function openPromiseFor(
  subscriptionId: string,
  cycle: Date,
): Promise<OpenPromise | null> {
  const { rows } = await query<{ id: string; promised_for: string }>(
    `SELECT id::text AS id, to_char(promised_for, 'YYYY-MM-DD') AS promised_for
       FROM promise_to_pay
      WHERE subscription_id = $1 AND cycle = $2 AND status = 'open'`,
    [subscriptionId, cycle],
  );
  const row = rows[0];
  if (!row) return null;

  const attemptAt = promiseAttemptTime(row.promised_for);
  if (!attemptAt) return null;

  return {
    id: row.id,
    subscription_id: subscriptionId,
    cycle,
    promised_for: row.promised_for,
    attempt_at: attemptAt,
  };
}

export async function resolvePromises(now = new Date()): Promise<{ kept: number; broken: number }> {
  const { rows: kept } = await query<{ id: string }>(
    `UPDATE promise_to_pay p
        SET status = 'kept', resolved_at = clock_timestamp()
      WHERE p.status = 'open'
        AND EXISTS (
          SELECT 1 FROM payment_attempt pa
           WHERE pa.subscription_id = p.subscription_id
             AND pa.cycle = p.cycle
             AND pa.status = 'captured'
             AND pa.attempted_at >= p.promised_at
        )
      RETURNING p.id::text AS id`,
  );

  const { rows: broken } = await query<{ id: string }>(
    `UPDATE promise_to_pay p
        SET status = 'broken', resolved_at = clock_timestamp()
      WHERE p.status = 'open'
        AND p.promised_for < ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
        AND EXISTS (
          SELECT 1 FROM payment_attempt pa
           WHERE pa.subscription_id = p.subscription_id
             AND pa.cycle = p.cycle
             AND pa.status = 'failed'
             AND pa.attempted_at >= p.promised_at
        )
      RETURNING p.id::text AS id`,
    [now],
  );

  if (kept.length > 0 || broken.length > 0) {
    log.info('promise.resolved', { kept: kept.length, broken: broken.length });
  }
  return { kept: kept.length, broken: broken.length };
}

export async function reliabilityFor(subscriptionId: string) {
  const { rows } = await query<PromiseRecord>(
    `SELECT to_char(promised_for, 'YYYY-MM-DD') AS promised_for, status
       FROM promise_to_pay WHERE subscription_id = $1 ORDER BY promised_at DESC LIMIT 20`,
    [subscriptionId],
  );
  return promiseReliability(rows);
}
