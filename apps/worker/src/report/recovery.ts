import { isHard } from '@mandate/core';
import type { Bucket } from '@mandate/core';
import { query } from '@mandate/db';
import { runBacktest } from '../backtest/run.ts';

export interface UrgentMandate {
  subscription_id: string;
  customer_ref: string;
  amount_paise: number;
  bucket: Bucket;
  attempts_used: number;
  days_to_halt: number;
}

export interface RecoveryReport {
  merchant_id: string;
  window_days: number;
  taxonomy_version: string;
  generated_at: string;
  has_history: boolean;
  money: {
    at_risk_paise: number;
    recovered_paise: number;
    lost_paise: number;
    addressable_paise: number;
    unclassified_paise: number;
    hard_paise: number;
    recovery_rate: number;
  };
  attempts: {
    spent_by_default: number;
    wasted_on_hard_declines: number;
    in_peak_windows: number;
    we_would_reschedule: number;
    we_would_not_spend: number;
  };
  urgent: UrgentMandate[];
  honesty: {
    unmapped_failures: number;
    unmapped_share: number;
    taxonomy_verified: boolean;
    sample_too_small: boolean;
  };
  headline: string;
  caveat: string | null;
}

interface CycleRow {
  amount_paise: number;
  recovered: boolean;
  bucket: string | null;
}

const CYCLE_SQL = `
  SELECT s.amount_paise::bigint AS amount_paise,
         bool_or(pa.status = 'captured') AS recovered,
         (array_agg(pa.bucket ORDER BY pa.attempted_at DESC)
            FILTER (WHERE pa.status = 'failed'))[1] AS bucket
    FROM payment_attempt pa
    JOIN subscription s ON s.id = pa.subscription_id
   WHERE s.merchant_id = $1
     AND pa.attempted_at > now() - ($2::int * interval '1 day')
   GROUP BY pa.subscription_id, pa.cycle, s.amount_paise
  HAVING bool_or(pa.status = 'failed')`;

const URGENT_SQL = `
  SELECT s.id AS subscription_id,
         s.customer_ref,
         s.amount_paise::bigint AS amount_paise,
         COALESCE(f.bucket, 'UNKNOWN') AS bucket,
         COALESCE(h.consecutive_failures, 0)::int AS attempts_used,
         GREATEST(0, COALESCE(EXTRACT(day FROM s.current_end - now())::int, 0)) AS days_to_halt
    FROM subscription s
    LEFT JOIN LATERAL (
      SELECT consecutive_failures FROM mandate_health mh
       WHERE mh.subscription_id = s.id ORDER BY scored_at DESC LIMIT 1
    ) h ON TRUE
    LEFT JOIN LATERAL (
      SELECT pa.bucket FROM payment_attempt pa
       WHERE pa.subscription_id = s.id AND pa.status = 'failed'
       ORDER BY pa.attempted_at DESC LIMIT 1
    ) f ON TRUE
   WHERE s.merchant_id = $1
     AND s.status IN ('active', 'pending')
     AND COALESCE(h.consecutive_failures, 0) > 0
   ORDER BY s.amount_paise DESC, days_to_halt ASC
   LIMIT 12`;

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

export async function buildRecoveryReport(
  merchantId: string,
  windowDays = 180,
): Promise<RecoveryReport> {
  const [{ rows: cycles }, { rows: urgent }, backtest] = await Promise.all([
    query<CycleRow>(CYCLE_SQL, [merchantId, windowDays]),
    query<UrgentMandate>(URGENT_SQL, [merchantId]),
    runBacktest(merchantId),
  ]);

  let atRisk = 0;
  let recovered = 0;
  let addressable = 0;
  let unclassified = 0;
  let hard = 0;

  for (const c of cycles) {
    const amount = Number(c.amount_paise);
    atRisk += amount;
    if (c.recovered) {
      recovered += amount;
      continue;
    }
    const bucket = (c.bucket ?? 'UNKNOWN') as Bucket;
    if (bucket === 'UNKNOWN') unclassified += amount;
    else if (isHard(bucket)) hard += amount;
    else addressable += amount;
  }

  const lost = atRisk - recovered;
  const t = backtest.totals;
  const unmappedShare = t.failures_examined > 0 ? t.unmapped_failures / t.failures_examined : 0;
  const sampleTooSmall = t.failures_examined < 30;

  const headline = cycles.length === 0
    ? 'No failed mandates found in this window.'
    : lost === 0
      ? `Every failed mandate in the last ${windowDays} days eventually recovered.`
      : `${rupees(lost)} failed and never recovered. ${rupees(addressable)} of it failed for reasons that respond to timing.`;

  const caveats: string[] = [];
  if (sampleTooSmall) {
    caveats.push(`Only ${t.failures_examined} failures in this window, too few to draw a reliable rate from.`);
  }
  if (unmappedShare > 0.2) {
    caveats.push(`${Math.round(unmappedShare * 100)}% of failures carry a decline code Helm has not mapped, so their money is counted as unclassified rather than recoverable.`);
  }
  if (unclassified > 0 && unmappedShare <= 0.2) {
    caveats.push(`${rupees(unclassified)} sits behind decline codes Helm has not mapped and is excluded from the recoverable figure.`);
  }

  return {
    merchant_id: merchantId,
    window_days: windowDays,
    taxonomy_version: backtest.taxonomy_version,
    generated_at: new Date().toISOString(),
    has_history: cycles.length > 0,
    money: {
      at_risk_paise: atRisk,
      recovered_paise: recovered,
      lost_paise: lost,
      addressable_paise: addressable,
      unclassified_paise: unclassified,
      hard_paise: hard,
      recovery_rate: atRisk > 0 ? recovered / atRisk : 0,
    },
    attempts: {
      spent_by_default: t.default_attempts_spent,
      wasted_on_hard_declines: t.default_attempts_on_hard_declines,
      in_peak_windows: t.default_attempts_in_peak_windows,
      we_would_reschedule: t.our_attempts_rescheduled,
      we_would_not_spend: t.attempts_we_would_not_have_spent,
    },
    urgent: urgent.map((u) => ({ ...u, amount_paise: Number(u.amount_paise) })),
    honesty: {
      unmapped_failures: t.unmapped_failures,
      unmapped_share: unmappedShare,
      taxonomy_verified: false,
      sample_too_small: sampleTooSmall,
    },
    headline,
    caveat: caveats.length > 0 ? caveats.join(' ') : null,
  };
}
