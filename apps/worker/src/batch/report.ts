import { DEFAULT_MODEL } from './simulator.ts';
import type { ArmResult, BatchResult } from './run.ts';

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : 'n/a';
}

function perAttempt(arm: ArmResult): number {
  return arm.attempts_spent > 0 ? arm.amount_recovered_paise / arm.attempts_spent : 0;
}

export function renderBatch(result: BatchResult): string {
  const c = result.control;
  const t = result.treatment;
  const model = result.generative_model ?? DEFAULT_MODEL;

  const cPer = perAttempt(c);
  const tPer = perAttempt(t);
  const delta = cPer > 0 ? ((tPer - cPer) / cPer) * 100 : 0;

  const lines = [
    '# Results',
    '',
    result.mode === 'simulated'
      ? '> **Simulated.** Charges did not reach Razorpay. Outcomes were drawn from the generative'
      : '> **Live.** Charges were executed against Razorpay.',
    result.mode === 'simulated'
      ? '> model stated below, with a fixed seed so every number here is reproducible. When live'
      : '> Every figure below is money that actually moved.',
    result.mode === 'simulated'
      ? '> credentials are supplied the same harness runs against real charges without modification.'
      : '',
    '',
    `Seed: \`${result.seed}\` · Mandates: ${c.mandates + t.mandates} · Median mandate: ${rupees(result.median_paise)}`,
    '',
    '## The two arms',
    '',
    '**Control** retries at T+1, T+2 and T+3 from the original failure, at the same time of day.',
    'That is the fixed schedule this system is being compared against.',
    '',
    '**Treatment** runs the full loop: success model, budget dynamic program, and the policy',
    'engine, with the same attempt budget and the same bounds.',
    '',
    'Assignment is by construction, alternating, so both arms see the same distribution of',
    'amounts, issuers and failure times.',
    '',
    '## Results',
    '',
    '| | Control | Treatment | |',
    '|---|---|---|---|',
    `| Mandates | ${c.mandates} | ${t.mandates} | |`,
    `| Amount at risk (**denominator**) | ${rupees(c.amount_at_risk_paise)} | ${rupees(t.amount_at_risk_paise)} | |`,
    `| Amount recovered | ${rupees(c.amount_recovered_paise)} | ${rupees(t.amount_recovered_paise)} | |`,
    `| Recovery rate | ${pct(c.amount_recovered_paise, c.amount_at_risk_paise)} | ${pct(t.amount_recovered_paise, t.amount_at_risk_paise)} | |`,
    `| Attempts spent | ${c.attempts_spent} | ${t.attempts_spent} | |`,
    `| **Recovered per attempt** | **${rupees(cPer)}** | **${rupees(tPer)}** | **${delta >= 0 ? '+' : ''}${Math.round(delta * 10) / 10}%** |`,
    `| Mandates recovered | ${c.mandates_recovered} | ${t.mandates_recovered} | |`,
    `| Mandates halted | ${c.mandates_halted} | ${t.mandates_halted} | |`,
    '',
    '**Recovered per attempt is the headline.** Total recovery rises with more attempts;',
    'efficiency does not. Since the attempt budget is fixed by the payment network, efficiency',
    'is the only axis that exists.',
    '',
  ];

  const haltGap = t.mandates_halted - c.mandates_halted;
  const lifetimeCost = haltGap * result.median_paise * 6;
  const efficiencyGain = (tPer - cPer) * t.attempts_spent;
  if (haltGap > 0) {
    lines.push(
      '## The tradeoff, stated plainly',
      '',
      `The treatment arm halted **${haltGap} more mandates** than the control arm (${t.mandates_halted} against ${c.mandates_halted})`,
      `while spending **${c.attempts_spent - t.attempts_spent} fewer attempts**.`,
      '',
      'That is not a bug. The allocator maximises recovery per attempt, which is the objective it',
      'was given, and declining marginal attempts is how it achieves that. The halt gap is the',
      'visible price of the objective.',
      '',
      'Whether the trade is worth taking depends on what a halted mandate costs the merchant. At',
      `the median mandate of ${rupees(result.median_paise)} across six remaining cycles, ${haltGap} extra halts is roughly`,
      `${rupees(lifetimeCost)} of lifetime value against a gain of ${rupees(efficiencyGain)} in`,
      `recovery efficiency. On this data the trade is **${efficiencyGain >= lifetimeCost ? 'favourable' : 'unfavourable'}**`,
      efficiencyGain >= lifetimeCost
        ? 'by that measure, but it rests on an assumed six remaining cycles per mandate. A merchant'
        : 'by that measure. A merchant',
      'who values mandate survival differently should weight the objective differently, and the',
      'allocator takes that weighting as an input rather than baking it in.',
      '',
      'It is reported here rather than tuned away.',
      '',
    );
  }

  const denials = Object.entries(t.denials_by_rule).sort((a, b) => b[1] - a[1]);
  if (denials.length > 0) {
    lines.push('## Where the treatment arm refused to spend an attempt', '', '| rule | count |', '|---|---|');
    for (const [rule, n] of denials) lines.push(`| \`${rule}\` | ${n} |`);
    lines.push('', 'Refusals are logged as loudly as approvals. An attempt not spent on a mandate that', 'could not be saved is available to one that can.', '');
  }

  if (result.mode === 'simulated') {
    lines.push(
      '## The generative model, stated in full',
      '',
      'Nothing here is hidden. These are the assumptions the simulated outcomes were drawn from,',
      'and they encode the contention hypothesis. If the hypothesis is wrong, this model is wrong,',
      'and the numbers above describe a world that does not exist.',
      '',
      '| parameter | value | meaning |',
      '|---|---|---|',
      `| \`base_success\` | ${model.base_success} | probability a debit clears outside any contested window |`,
      `| \`payday_days\` | ${JSON.stringify(model.payday_days)} | days of month when mandates cluster |`,
      `| \`contention_hours\` | ${model.contention_hours[0]}:00–${model.contention_hours[model.contention_hours.length - 1]! + 1}:00 IST | the window where debits collide |`,
      `| \`contention_penalty\` | ${model.contention_penalty} | how much clearing probability drops inside it |`,
      `| \`amount_sensitivity\` | ${model.amount_sensitivity} | how much worse a large debit fares when contended |`,
      `| \`pre_payday_penalty\` | ${model.pre_payday_penalty} | how much worse the end of the month is |`,
      '',
      '`amount_sensitivity` is the parameter the whole thesis rests on. It says a larger debit',
      'needs more residual balance to clear, so it suffers more from arriving late in a queue.',
      'That is exactly the effect the contention test looks for in real data — and until real',
      'data confirms it, this figure is an assumption rather than a measurement.',
      '',
      '## What this does and does not establish',
      '',
      'It **does** establish that the policy, the model and the bounds compose into a working loop',
      'over a batch, and that under a stated model the allocator spends a fixed budget better than',
      'a fixed schedule.',
      '',
      'It **does not** establish that Indian autopay behaves like this model. Only real data can do',
      'that, and the contention test is the thing that will decide it.',
      '',
    );
  }

  return lines.join('\n');
}
