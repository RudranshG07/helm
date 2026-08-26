import type { BacktestResult } from './run.ts';

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : 'n/a';
}

export function renderBacktest(result: BacktestResult, provenance: string): string {
  const t = result.totals;
  const lines: string[] = [];

  lines.push('# Backtest');
  lines.push('');
  lines.push(`Data provenance: **${provenance}**`);
  lines.push(`Taxonomy version: \`${result.taxonomy_version}\``);
  lines.push(`Generated: ${result.generated_at.toISOString()}`);
  lines.push('');

  lines.push('## What a backtest can and cannot tell you');
  lines.push('');
  lines.push('History records the outcome of attempts that **were** made. It contains no outcome for');
  lines.push('an attempt that was never made, so this report does not claim a recovery figure.');
  lines.push('');
  lines.push('What it does claim is checkable: an attempt spent on a decline that could not succeed');
  lines.push('was wasted, and the historical record shows it failed. Those attempts are counted below.');
  lines.push('');

  if (t.failures_examined === 0) {
    lines.push('## No data');
    lines.push('');
    lines.push('No failed payments were found. This report is empty on purpose rather than fabricated.');
    return lines.join('\n');
  }

  lines.push('## Population');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Failed payments examined | ${t.failures_examined} |`);
  lines.push(`| Subscriptions involved | ${t.subscriptions} |`);
  lines.push(`| Amount at risk (the denominator) | ${rupees(t.amount_at_risk_paise)} |`);
  lines.push(`| Recovered under the default schedule | ${rupees(t.amount_recovered_by_default_paise)} (${pct(t.amount_recovered_by_default_paise, t.amount_at_risk_paise)}) |`);
  lines.push('');

  lines.push('## Attempts');
  lines.push('');
  lines.push('| | Default schedule | This policy |');
  lines.push('|---|---|---|');
  lines.push(`| Retry attempts spent after a failure | ${t.default_attempts_spent} | ${t.our_attempts_authorised} |`);
  lines.push(`| Of those, spent on a hard decline | ${t.default_attempts_on_hard_declines} | 0 |`);
  lines.push(`| Landing inside a peak execution window | ${t.default_attempts_in_peak_windows} | 0 |`);
  lines.push(`| Moved to a different window by policy | n/a | ${t.our_attempts_rescheduled} |`);
  lines.push('');
  if (t.default_attempts_in_peak_windows > 0) {
    lines.push(
      `**${t.default_attempts_in_peak_windows}** of the default schedule's retries landed inside a ` +
        'peak execution window. A fixed 24-hour offset repeats the original failure\'s time of day, ' +
        'so a charge that first failed during peak hours is retried during peak hours every time.',
    );
    lines.push('');
  }
  lines.push(
    `The default schedule spent **${t.default_attempts_on_hard_declines}** attempts on declines that ` +
      'could not succeed. Every one of them failed, which the record confirms. This policy would ' +
      'have spent none, because a hard decline is refused before an attempt is authorised.',
  );
  lines.push('');

  const refusals = Object.entries(t.our_refusals_by_rule).sort((a, b) => b[1] - a[1]);
  if (refusals.length > 0) {
    lines.push('## Why this policy refused');
    lines.push('');
    lines.push('| rule | count |');
    lines.push('|---|---|');
    for (const [rule, count] of refusals) lines.push(`| \`${rule}\` | ${count} |`);
    lines.push('');
  }

  lines.push('## Timing model coverage');
  lines.push('');
  lines.push('| tier | decisions | meaning |');
  lines.push('|---|---|---|');
  const tierMeaning: Record<string, string> = {
    own_history: 'inferred from this customer\'s own successful payments',
    merchant_default: 'fell back to the merchant\'s overall pattern',
    population_default: 'fell back to a population default, effectively no prediction',
  };
  for (const [tier, count] of Object.entries(t.liquidity_tiers).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${tier} | ${count} | ${tierMeaning[tier] ?? ''} |`);
  }
  lines.push('');
  const populationCount = t.liquidity_tiers['population_default'] ?? 0;
  if (populationCount / t.failures_examined > 0.5) {
    lines.push(
      `**Most decisions (${pct(populationCount, t.failures_examined)}) fell back to a population ` +
        'default.** On this data the timing model is not making a real prediction, and any timing ' +
        'improvement claimed from it would be unsupported.',
    );
    lines.push('');
  }

  lines.push('## Honesty metrics');
  lines.push('');
  lines.push(`| Failures we could not classify | ${t.unmapped_failures} (${pct(t.unmapped_failures, t.failures_examined)}) |`);
  lines.push('|---|---|');
  lines.push('');
  if (t.unmapped_failures > 0) {
    lines.push(
      'Unmapped failures received one conservative attempt rather than the full budget. A large ' +
        'unmapped share means the numbers above describe behaviour we do not fully understand yet.',
    );
    lines.push('');
  }

  return lines.join('\n');
}
