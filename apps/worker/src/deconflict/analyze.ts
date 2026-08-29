import { deconflict, describeWindow, findCollisions } from '@mandate/core';
import type { DeconflictResult, ScheduledDebit } from '@mandate/core';
import { query } from '@mandate/db';

export interface CoverageReport {
  scheduled: number;
  with_customer_key: number;
  merchants_opted_in: number;
  customers_shared: number;
}

const SCHEDULED_SQL = `
SELECT
  d.id::text AS id,
  s.merchant_id,
  s.customer_key,
  s.amount_paise,
  d.scheduled_for AS at,
  d.scheduled_for AS earliest,
  COALESCE(s.current_end, d.scheduled_for + interval '14 days') AS latest
FROM decision d
JOIN subscription s ON s.id = d.subscription_id
JOIN merchant m ON m.id = s.merchant_id
WHERE d.verdict = 'ALLOW'
  AND d.proposed_action = 'RETRY_SCHEDULED'
  AND d.scheduled_for IS NOT NULL
  AND d.executed_at IS NULL
  AND d.outcome IS NULL
  AND m.cross_merchant_signals
  AND s.customer_key IS NOT NULL
ORDER BY d.scheduled_for
`;

export interface DeconflictAnalysis {
  coverage: CoverageReport;
  result: DeconflictResult | null;
  shared_customers: { customer_key: string; merchants: number; debits: number }[];
}

export async function analyzeDeconfliction(): Promise<DeconflictAnalysis> {
  const { rows: cover } = await query<CoverageReport>(
    `SELECT
       (SELECT count(*)::int FROM decision
         WHERE verdict='ALLOW' AND proposed_action='RETRY_SCHEDULED'
           AND scheduled_for IS NOT NULL AND executed_at IS NULL AND outcome IS NULL) AS scheduled,
       (SELECT count(*)::int FROM decision d JOIN subscription s ON s.id=d.subscription_id
         WHERE d.verdict='ALLOW' AND d.proposed_action='RETRY_SCHEDULED'
           AND d.scheduled_for IS NOT NULL AND d.executed_at IS NULL AND d.outcome IS NULL
           AND s.customer_key IS NOT NULL) AS with_customer_key,
       (SELECT count(*)::int FROM merchant WHERE cross_merchant_signals) AS merchants_opted_in,
       (SELECT count(*)::int FROM (
          SELECT customer_key FROM subscription
           WHERE customer_key IS NOT NULL
           GROUP BY customer_key HAVING count(DISTINCT merchant_id) > 1
        ) x) AS customers_shared`,
  );

  const { rows } = await query<ScheduledDebit>(SCHEDULED_SQL);
  const debits = rows.map((r) => ({
    ...r,
    at: new Date(r.at),
    earliest: new Date(r.earliest),
    latest: new Date(r.latest),
  }));

  const { rows: shared } = await query<{ customer_key: string; merchants: number; debits: number }>(
    `SELECT s.customer_key, count(DISTINCT s.merchant_id)::int AS merchants, count(*)::int AS debits
       FROM subscription s
      WHERE s.customer_key IS NOT NULL
      GROUP BY s.customer_key
     HAVING count(DISTINCT s.merchant_id) > 1
      ORDER BY merchants DESC, debits DESC
      LIMIT 20`,
  );

  return {
    coverage: cover[0]!,
    result: debits.length > 0 ? deconflict(debits) : null,
    shared_customers: shared,
  };
}

export function renderDeconfliction(a: DeconflictAnalysis): string {
  const c = a.coverage;
  const lines = [
    '# Debit de-confliction',
    '',
    'If payday failure is a queueing collision rather than a funding shortfall, it is a',
    'coordination failure. The customer often has enough money; the debits simply arrive',
    'together. Spreading them across the day pays every merchant, and nobody gives anything up.',
    '',
    'Only a layer that sits across many merchants can do this. A single merchant optimising',
    'alone just tries to be first, which makes the collision worse for everyone.',
    '',
    '## Coverage',
    '',
    '| | |',
    '|---|---|',
    `| Scheduled retries | ${c.scheduled} |`,
    `| Carrying a cross-merchant customer key | ${c.with_customer_key} |`,
    `| Merchants opted into pooling | ${c.merchants_opted_in} |`,
    `| Customers seen at more than one merchant | ${c.customers_shared} |`,
    '',
  ];

  if (c.with_customer_key === 0) {
    lines.push(
      '## Nothing to de-conflict yet',
      '',
      'De-confliction needs the same person to be identifiable across merchants. That requires a',
      'stable key each merchant can supply, derived from a hashed VPA or contact, and it requires',
      'those merchants to have opted into pooling. Neither is inferred and neither is guessed at:',
      'a mandate with no customer key simply does not participate.',
      '',
      'This is the honest state. The mechanism is built and tested; what it needs is more than one',
      'merchant sharing a customer.',
      '',
    );
    return lines.join('\n');
  }

  const r = a.result!;
  lines.push(
    '## Result',
    '',
    '| | |',
    '|---|---|',
    `| Collisions before | ${r.collisions_before} |`,
    `| Collisions after | ${r.collisions_after} |`,
    `| Debits moved | ${r.debits_moved} |`,
    `| Could not be resolved | ${r.unresolvable.length} |`,
    '',
  );

  if (r.debits_moved > 0) {
    lines.push('| debit | from | to | why |', '|---|---|---|---|');
    for (const asg of r.assignments.filter((x) => x.moved).slice(0, 25)) {
      lines.push(
        `| \`${asg.id}\` | ${describeWindow(asg.original_at)} | ${describeWindow(asg.assigned_at)} | ${asg.reason} |`,
      );
    }
    lines.push('');
  }

  if (r.unresolvable.length > 0) {
    lines.push(
      `${r.unresolvable.length} debit(s) had no free legal slot inside their own window. They were ` +
        'left where they were rather than pushed somewhere illegal.',
      '',
    );
  }

  if (a.shared_customers.length > 0) {
    lines.push('## Customers seen at more than one merchant', '', '| key | merchants | mandates |', '|---|---|---|');
    for (const s of a.shared_customers) {
      lines.push(`| \`${s.customer_key.slice(0, 12)}…\` | ${s.merchants} | ${s.debits} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export { findCollisions };
