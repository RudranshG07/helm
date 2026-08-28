import { dayBand, hourBand, testContention } from '@mandate/core';
import type { AttemptObservation, ContentionTest } from '@mandate/core';
import { query } from '@mandate/db';

export interface WindowDefinition {
  label: string;
  match: (o: AttemptObservation) => boolean;
}

export const CONTESTED: WindowDefinition = {
  label: 'payday, first hours (day 1-3, 00:00-06:00 IST)',
  match: (o) => dayBand(o.day_of_month) === 'payday' && hourBand(o.hour) === 'night',
};

export const UNCONTESTED: WindowDefinition = {
  label: 'same days, afternoon (day 1-3, 13:00-17:00 IST)',
  match: (o) => dayBand(o.day_of_month) === 'payday' && hourBand(o.hour) === 'afternoon',
};

export async function loadObservations(merchantId?: string): Promise<AttemptObservation[]> {
  const { rows } = await query<{
    day_of_month: number;
    hour: number;
    amount_paise: number;
    succeeded: boolean;
  }>(
    `SELECT
       EXTRACT(DAY  FROM pa.attempted_at AT TIME ZONE 'Asia/Kolkata')::int  AS day_of_month,
       EXTRACT(HOUR FROM pa.attempted_at AT TIME ZONE 'Asia/Kolkata')::int  AS hour,
       pa.amount_paise,
       (pa.status = 'captured') AS succeeded
     FROM payment_attempt pa
     JOIN subscription s ON s.id = pa.subscription_id
     WHERE pa.status IN ('captured','failed')
       AND (pa.status = 'captured' OR pa.error_reason = 'insufficient_funds')
       AND ($1::text IS NULL OR s.merchant_id = $1)`,
    [merchantId ?? null],
  );
  return rows;
}

export interface ContentionAnalysis {
  test: ContentionTest;
  contested_label: string;
  uncontested_label: string;
  contested_n: number;
  uncontested_n: number;
  total_observations: number;
  hourly_failure_profile: { hour: number; attempts: number; failure_rate: number }[];
}

export async function analyzeContention(merchantId?: string): Promise<ContentionAnalysis> {
  const all = await loadObservations(merchantId);
  const contested = all.filter(CONTESTED.match);
  const uncontested = all.filter(UNCONTESTED.match);

  const byHour = new Map<number, { attempts: number; failures: number }>();
  for (const o of all) {
    const cell = byHour.get(o.hour) ?? { attempts: 0, failures: 0 };
    cell.attempts += 1;
    if (!o.succeeded) cell.failures += 1;
    byHour.set(o.hour, cell);
  }

  return {
    test: testContention(contested, uncontested),
    contested_label: CONTESTED.label,
    uncontested_label: UNCONTESTED.label,
    contested_n: contested.length,
    uncontested_n: uncontested.length,
    total_observations: all.length,
    hourly_failure_profile: [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, c]) => ({
        hour,
        attempts: c.attempts,
        failure_rate: c.attempts > 0 ? Math.round((c.failures / c.attempts) * 1000) / 1000 : 0,
      })),
  };
}

export function renderContention(a: ContentionAnalysis, provenance: string): string {
  const t = a.test;
  const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 1000) / 10}%`);

  const headline: Record<ContentionTest['verdict'], string> = {
    contention: 'SUPPORTED — the amount effect concentrates in the contested window',
    funding: 'NOT SUPPORTED — the amount effect points the other way',
    inconclusive_low_volume: 'UNTESTED — not enough observations to conclude anything',
    inconclusive_no_difference: 'NOT SUPPORTED — no material difference between windows',
  };

  const lines = [
    '# Is Indian autopay failure a queueing collision?',
    '',
    `Data provenance: **${provenance}**`,
    `Observations: ${a.total_observations}`,
    '',
    '## The hypothesis',
    '',
    'On payday, every mandate a customer holds fires in the same window. Debits race one',
    'balance. The early ones clear and the late ones bounce, against an account that was',
    'funded that morning. If that is what is happening, `insufficient_funds` is a scheduling',
    'collision rather than a funding shortfall, and retrying 24 hours later re-enters the',
    'same queue on an emptier account.',
    '',
    '## The test',
    '',
    'An empty account rejects small and large debits alike. A contended account does not:',
    'clearing a larger debit requires more residual balance after earlier debits have taken',
    'their cut. So the hypothesis makes a falsifiable prediction.',
    '',
    '> If failures are **funding**-driven, the gap between small-debit and large-debit success',
    '> rates is the same in contested and uncontested windows.',
    '>',
    '> If failures are **contention**-driven, that gap is **wider in the contested window**.',
    '',
    `Contested window: ${a.contested_label} (${a.contested_n} observations)`,
    `Uncontested window: ${a.uncontested_label} (${a.uncontested_n} observations)`,
    `Amount split at the population median: ₹${(t.threshold_paise / 100).toFixed(2)}`,
    '',
    '## Result',
    '',
    `**${headline[t.verdict]}**`,
    '',
    '| window | small-debit success | large-debit success | gap |',
    '|---|---|---|---|',
    `| contested | ${pct(t.contested.small_success_rate)} | ${pct(t.contested.large_success_rate)} | ${pct(t.contested.gap)} |`,
    `| uncontested | ${pct(t.uncontested.small_success_rate)} | ${pct(t.uncontested.large_success_rate)} | ${pct(t.uncontested.gap)} |`,
    '',
    `Differential: ${t.differential === null ? 'n/a' : pct(t.differential)}  ·  z = ${t.z ?? 'n/a'}`,
    '',
    t.explanation,
    '',
  ];

  if (t.verdict !== 'contention') {
    lines.push('## What this means for the product', '');
    lines.push(
      'The scheduler does not assume the hypothesis. It reads this verdict and falls back to',
      'timing on funding alone when contention is unsupported. The finding is reported either',
      'way, because a tested hypothesis that failed is worth more than an untested assumption.',
      '',
    );
  }

  if (a.hourly_failure_profile.length > 0) {
    lines.push('## Failure rate by hour (IST)', '', '| hour | attempts | failure rate |', '|---|---|---|');
    for (const h of a.hourly_failure_profile) {
      lines.push(`| ${String(h.hour).padStart(2, '0')}:00 | ${h.attempts} | ${pct(h.failure_rate)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
