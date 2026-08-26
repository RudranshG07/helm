import { query } from '@mandate/db';
import type { Bucket, Method } from '@mandate/core';

export class LeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeakageError';
  }
}

export interface HistoricalAttempt {
  id: number;
  subscription_id: string;
  cycle: Date;
  attempted_at: Date;
  status: string;
  amount_paise: number;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  error_code: string | null;
  bucket: Bucket | null;
  issuer: string | null;
  initiated_by: string;
  method: Method;
  mandate_expiry_at: Date | null;
  subscription_status: string;
}

export interface PriorState {
  attempts_before: number;
  failures_before: number;
  captured_before: boolean;
  success_days: number[];
  last_bucket: Bucket | null;
}

export class AsOfLoader {
  private readonly asOf: Date;

  constructor(asOf: Date) {
    if (!Number.isFinite(asOf.getTime())) {
      throw new LeakageError('as_of must be a valid instant');
    }
    this.asOf = asOf;
  }

  get cutoff(): Date {
    return this.asOf;
  }

  private assertNoFuture(rows: { attempted_at: Date }[], label: string): void {
    for (const row of rows) {
      if (row.attempted_at >= this.asOf) {
        throw new LeakageError(
          `${label} returned a row at ${row.attempted_at.toISOString()}, at or after the cutoff ${this.asOf.toISOString()}`,
        );
      }
    }
  }

  async priorState(subscriptionId: string, cycle: Date): Promise<PriorState> {
    const { rows } = await query<{
      attempted_at: Date;
      status: string;
      bucket: Bucket | null;
      cycle: Date;
      day_of_month: number;
    }>(
      `SELECT attempted_at, status, bucket, cycle,
              EXTRACT(DAY FROM attempted_at AT TIME ZONE 'Asia/Kolkata')::int AS day_of_month
         FROM payment_attempt
        WHERE subscription_id = $1
          AND attempted_at < $2
        ORDER BY attempted_at`,
      [subscriptionId, this.asOf],
    );

    this.assertNoFuture(rows, 'priorState');

    const inCycle = rows.filter((r) => r.cycle.getTime() === cycle.getTime());
    const failures = rows.filter((r) => r.status === 'failed');

    return {
      attempts_before: inCycle.length,
      failures_before: inCycle.filter((r) => r.status === 'failed').length,
      captured_before: inCycle.some((r) => r.status === 'captured'),
      success_days: rows.filter((r) => r.status === 'captured').map((r) => r.day_of_month),
      last_bucket: failures.length > 0 ? failures[failures.length - 1]!.bucket : null,
    };
  }
}

export async function loadHistory(merchantId?: string): Promise<HistoricalAttempt[]> {
  const { rows } = await query<HistoricalAttempt>(
    `SELECT
       pa.id, pa.subscription_id, pa.cycle, pa.attempted_at, pa.status, pa.amount_paise,
       pa.error_reason, pa.error_source, pa.error_step, pa.error_code, pa.bucket,
       pa.issuer, pa.initiated_by,
       s.method, s.mandate_expiry_at, s.status AS subscription_status
     FROM payment_attempt pa
     JOIN subscription s ON s.id = pa.subscription_id
     WHERE ($1::text IS NULL OR s.merchant_id = $1)
     ORDER BY pa.attempted_at, pa.id`,
    [merchantId ?? null],
  );
  return rows;
}

export async function subsequentAttempts(
  subscriptionId: string,
  cycle: Date,
  after: Date,
): Promise<HistoricalAttempt[]> {
  const { rows } = await query<HistoricalAttempt>(
    `SELECT
       pa.id, pa.subscription_id, pa.cycle, pa.attempted_at, pa.status, pa.amount_paise,
       pa.error_reason, pa.error_source, pa.error_step, pa.error_code, pa.bucket,
       pa.issuer, pa.initiated_by,
       s.method, s.mandate_expiry_at, s.status AS subscription_status
     FROM payment_attempt pa
     JOIN subscription s ON s.id = pa.subscription_id
     WHERE pa.subscription_id = $1 AND pa.cycle = $2 AND pa.attempted_at > $3
     ORDER BY pa.attempted_at`,
    [subscriptionId, cycle, after],
  );
  return rows;
}
