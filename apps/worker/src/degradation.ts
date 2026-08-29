import { detectDegradation } from '@mandate/core';
import { query } from '@mandate/db';
import { log } from './log.ts';

interface RollupRow {
  issuer: string | null;
  method: string;
  baseline_attempts: number;
  baseline_successes: number;
  current_attempts: number;
  current_successes: number;
}

const ROLLUP_SQL = `
SELECT
  pa.issuer,
  s.method,
  count(*) FILTER (WHERE pa.attempted_at BETWEEN now() - interval '14 days'
                                             AND now() - interval '2 hours')::int AS baseline_attempts,
  count(*) FILTER (WHERE pa.attempted_at BETWEEN now() - interval '14 days'
                                             AND now() - interval '2 hours'
                     AND pa.status = 'captured')::int AS baseline_successes,
  count(*) FILTER (WHERE pa.attempted_at > now() - interval '2 hours')::int AS current_attempts,
  count(*) FILTER (WHERE pa.attempted_at > now() - interval '2 hours'
                     AND pa.status = 'captured')::int AS current_successes
FROM payment_attempt pa
JOIN subscription s ON s.id = pa.subscription_id
JOIN merchant m ON m.id = s.merchant_id
WHERE pa.attempted_at > now() - interval '14 days'
  AND m.cross_merchant_signals
  AND ($1::text IS NULL OR s.merchant_id = $1)
GROUP BY pa.issuer, s.method
`;

export async function rollupDegradation(merchantId?: string): Promise<number> {
  const { rows } = await query<RollupRow>(ROLLUP_SQL, [merchantId ?? null]);
  let opened = 0;

  for (const row of rows) {
    const verdict = detectDegradation({
      baseline: { attempts: row.baseline_attempts, successes: row.baseline_successes },
      current: { attempts: row.current_attempts, successes: row.current_successes },
    });

    const open = await query<{ id: number }>(
      `SELECT id FROM degradation_signal
        WHERE source = 'internal_rollup' AND method = $1
          AND issuer IS NOT DISTINCT FROM $2 AND resolved_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [row.method, row.issuer],
    );

    if (verdict.degraded && open.rows.length === 0) {
      await query(
        `INSERT INTO degradation_signal (
           source, issuer, method, severity, baseline_rate, current_rate, sample_size, started_at
         ) VALUES ('internal_rollup', $1, $2, 'detected', $3, $4, $5, now())`,
        [row.issuer, row.method, verdict.baseline_rate, verdict.current_rate, verdict.sample_size],
      );
      opened += 1;
      log.warn('degradation.opened', {
        issuer: row.issuer,
        method: row.method,
        baseline_rate: verdict.baseline_rate,
        current_rate: verdict.current_rate,
        z: verdict.z,
        sample_size: verdict.sample_size,
      });
    }

    if (!verdict.degraded && open.rows.length > 0) {
      await query(`UPDATE degradation_signal SET resolved_at = now() WHERE id = $1`, [open.rows[0]!.id]);
      log.info('degradation.resolved', { issuer: row.issuer, method: row.method });
    }
  }

  return opened;
}

export async function isDegraded(issuer: string | null, method: string): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM degradation_signal
      WHERE resolved_at IS NULL
        AND method = $2
        AND (issuer IS NULL OR issuer IS NOT DISTINCT FROM $1)`,
    [issuer, method],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function recordRazorpayDowntime(event: {
  issuer: string | null;
  method: string;
  severity: string | null;
  started_at: Date;
  resolved: boolean;
}): Promise<void> {
  if (event.resolved) {
    await query(
      `UPDATE degradation_signal SET resolved_at = now()
        WHERE source = 'razorpay_downtime' AND method = $1
          AND issuer IS NOT DISTINCT FROM $2 AND resolved_at IS NULL`,
      [event.method, event.issuer],
    );
    return;
  }

  await query(
    `INSERT INTO degradation_signal (source, issuer, method, severity, started_at)
     SELECT 'razorpay_downtime', $1, $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM degradation_signal
         WHERE source = 'razorpay_downtime' AND method = $2
           AND issuer IS NOT DISTINCT FROM $1 AND resolved_at IS NULL
      )`,
    [event.issuer, event.method, event.severity, event.started_at],
  );
}

export interface LeadTime {
  issuer: string | null;
  method: string;
  internal_started_at: Date;
  razorpay_started_at: Date;
  lead_seconds: number;
}

export async function leadTimes(): Promise<LeadTime[]> {
  const { rows } = await query<LeadTime>(
    `SELECT
       i.issuer, i.method,
       i.started_at AS internal_started_at,
       r.started_at AS razorpay_started_at,
       EXTRACT(EPOCH FROM (r.started_at - i.started_at))::int AS lead_seconds
     FROM degradation_signal i
     JOIN LATERAL (
       SELECT started_at FROM degradation_signal r
        WHERE r.source = 'razorpay_downtime'
          AND r.method = i.method
          AND r.issuer IS NOT DISTINCT FROM i.issuer
          AND r.started_at BETWEEN i.started_at - interval '6 hours' AND i.started_at + interval '6 hours'
        ORDER BY abs(EXTRACT(EPOCH FROM (r.started_at - i.started_at)))
        LIMIT 1
     ) r ON TRUE
     WHERE i.source = 'internal_rollup'
     ORDER BY i.started_at DESC`,
  );
  return rows;
}
