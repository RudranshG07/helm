import { evaluateOffPolicy } from '@mandate/core';
import type { LoggedDecision, OpeEstimate } from '@mandate/core';
import { query } from '@mandate/db';

export interface OpeAnalysis {
  estimate: OpeEstimate;
  decisions_total: number;
  decisions_with_propensity: number;
  decisions_explored: number;
  decisions_settled: number;
}

export async function analyzeOffPolicy(): Promise<OpeAnalysis> {
  const { rows: counts } = await query<{
    total: number; with_propensity: number; explored: number; settled: number;
  }>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE logging_propensity IS NOT NULL)::int AS with_propensity,
       count(*) FILTER (WHERE explored)::int AS explored,
       count(*) FILTER (WHERE outcome IS NOT NULL)::int AS settled
     FROM decision`,
  );

  const { rows } = await query<LoggedDecision>(
    `SELECT
       d.proposed_action AS action,
       d.logging_propensity::float8 AS logging_propensity,
       d.target_propensity::float8  AS target_propensity,
       CASE WHEN d.outcome = 'recovered' THEN s.amount_paise ELSE 0 END AS reward_paise,
       COALESCE(d.expected_paise, 0)::float8 AS predicted_reward_paise
     FROM decision d
     JOIN subscription s ON s.id = d.subscription_id
     WHERE d.logging_propensity IS NOT NULL
       AND d.outcome IS NOT NULL`,
  );

  const c = counts[0]!;
  return {
    estimate: evaluateOffPolicy(rows),
    decisions_total: c.total,
    decisions_with_propensity: c.with_propensity,
    decisions_explored: c.explored,
    decisions_settled: c.settled,
  };
}

export function renderOpe(a: OpeAnalysis): string {
  const r = (paise: number | null) => (paise === null ? 'n/a' : `₹${(paise / 100).toFixed(2)}`);
  const e = a.estimate;

  const lines = [
    '# Off-policy evaluation',
    '',
    'A clean A/B needs more mandates than a buildathon has. Off-policy evaluation estimates what',
    'the current policy would earn from decisions it did not itself generate, using the',
    'propensity recorded at the time each decision was taken.',
    '',
    '## Coverage',
    '',
    '| | |',
    '|---|---|',
    `| Decisions recorded | ${a.decisions_total} |`,
    `| Carrying a propensity | ${a.decisions_with_propensity} |`,
    `| Taken as exploration | ${a.decisions_explored} |`,
    `| Settled with an outcome | ${a.decisions_settled} |`,
    `| Usable for estimation | ${e.n} |`,
    '',
    '## Estimate',
    '',
    '| estimator | value per decision |',
    '|---|---|',
    `| Observed (what actually happened) | ${r(e.observed_paise)} |`,
    `| Importance sampling | ${r(e.ips_paise)} |`,
    `| Self-normalised | ${r(e.snips_paise)} |`,
    `| Doubly robust | ${r(e.doubly_robust_paise)} |`,
    '',
    `Effective sample size **${e.effective_sample_size}** · largest weight ${e.max_weight} · ${e.clipped} clipped`,
    '',
    `**Support: ${e.support.replace(/_/g, ' ')}**`,
    '',
    e.explanation,
    '',
  ];

  if (e.support === 'deterministic_logger' || e.support === 'no_support') {
    lines.push(
      '## Why there is no number here yet',
      '',
      'This is the honest state, not a missing feature. Importance sampling needs the logged',
      'policy to have sometimes taken actions the target policy would not, otherwise the data',
      'carries no information about the alternatives.',
      '',
      'The allocator therefore explores: on a configurable fraction of decisions it takes a',
      'slot other than its first choice and records the probability with which it did so. Those',
      'recorded propensities are what makes this table fillable. It needs settled outcomes to',
      'accumulate before it can say anything, and it says nothing until then.',
      '',
    );
  }

  return lines.join('\n');
}
