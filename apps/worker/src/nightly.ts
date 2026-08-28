import { NPCI_ATTEMPT_BUDGET, score } from '@mandate/core';
import type { Bucket, Method } from '@mandate/core';
import { query } from '@mandate/db';
import { isDegraded } from './degradation.ts';
import { log } from './log.ts';

interface Candidate {
  subscription_id: string;
  method: Method;
  amount_paise: number;
  mandate_expiry_at: Date | null;
  cycle: Date;
  attempts_used: number;
  consecutive_failures: number;
  soft_rate: string;
  last_bucket: Bucket | null;
  issuer: string | null;
  last_scored_at: Date | null;
}

const SWEEP_SQL = `
SELECT
  s.id AS subscription_id, s.method, s.amount_paise, s.mandate_expiry_at,
  COALESCE(s.current_start, to_timestamp(0)) AS cycle,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = s.id
      AND cycle = COALESCE(s.current_start, to_timestamp(0))
      AND counts_against_budget) AS attempts_used,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = s.id
      AND cycle = COALESCE(s.current_start, to_timestamp(0))
      AND status = 'failed') AS consecutive_failures,
  COALESCE((SELECT avg(CASE WHEN bucket LIKE 'SOFT%' THEN 1 ELSE 0 END)
              FROM payment_attempt WHERE subscription_id = s.id AND status = 'failed'), 0) AS soft_rate,
  (SELECT bucket FROM payment_attempt
    WHERE subscription_id = s.id AND status = 'failed'
    ORDER BY attempted_at DESC LIMIT 1) AS last_bucket,
  (SELECT issuer FROM payment_attempt
    WHERE subscription_id = s.id
    ORDER BY attempted_at DESC LIMIT 1) AS issuer,
  (SELECT max(scored_at) FROM mandate_health WHERE subscription_id = s.id) AS last_scored_at
FROM subscription s
WHERE s.status NOT IN ('halted','cancelled','completed','expired')
  AND ($2::text IS NULL OR s.merchant_id = $2)
ORDER BY s.amount_paise DESC
LIMIT $1
`;

export interface SweepResult {
  examined: number;
  scored: number;
  newly_at_risk: number;
  newly_critical: number;
  before_any_failure: number;
}

export interface SweepOptions {
  limit?: number;
  minIntervalMs?: number;
  merchantId?: string;
}

export async function nightlySweep(
  now = new Date(),
  options: SweepOptions = {},
): Promise<SweepResult> {
  const limit = options.limit ?? 5000;
  const minIntervalMs = options.minIntervalMs ?? 20 * 3600 * 1000;
  const { rows } = await query<Candidate>(SWEEP_SQL, [limit, options.merchantId ?? null]);
  const result: SweepResult = {
    examined: rows.length,
    scored: 0,
    newly_at_risk: 0,
    newly_critical: 0,
    before_any_failure: 0,
  };

  for (const row of rows) {
    if (row.last_scored_at && now.getTime() - row.last_scored_at.getTime() < minIntervalMs) {
      continue;
    }

    const previous = await query<{ risk_band: string }>(
      `SELECT risk_band FROM mandate_health
        WHERE subscription_id = $1 ORDER BY scored_at DESC, id DESC LIMIT 1`,
      [row.subscription_id],
    );
    const was = previous.rows[0]?.risk_band ?? 'healthy';

    const health = score({
      now,
      consecutive_failures: row.consecutive_failures,
      attempts_used_this_cycle: row.attempts_used,
      mandate_expiry_at: row.mandate_expiry_at,
      soft_decline_rate: Number(row.soft_rate),
      issuer_degraded: await isDegraded(row.issuer, row.method),
      method: row.method,
      last_bucket: row.last_bucket,
    });

    await query(
      `INSERT INTO mandate_health (
         subscription_id, scored_at, consecutive_failures, attempts_remaining, days_to_expiry,
         risk_score, risk_band, contributions, amount_at_risk_paise
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.subscription_id, now, row.consecutive_failures, health.attempts_remaining,
        health.days_to_expiry, health.risk_score, health.risk_band, health.contributions,
        health.risk_band === 'healthy' ? 0 : row.amount_paise,
      ],
    );
    result.scored += 1;

    if (was === 'healthy' && health.risk_band === 'at_risk') result.newly_at_risk += 1;
    if (was !== 'critical' && health.risk_band === 'critical') result.newly_critical += 1;

    if (health.risk_band !== 'healthy' && row.consecutive_failures === 0) {
      result.before_any_failure += 1;
      log.warn('nightly.at_risk_before_failure', {
        subscription_id: row.subscription_id,
        risk_band: health.risk_band,
        days_to_expiry: health.days_to_expiry,
        attempts_remaining: health.attempts_remaining,
        contributions: health.contributions,
      });
    }
  }

  return result;
}

export function isSweepDue(lastRun: Date | null, now: Date, intervalMs: number): boolean {
  if (!lastRun) return true;
  return now.getTime() - lastRun.getTime() >= intervalMs;
}
