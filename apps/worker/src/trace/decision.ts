import { PEAK_WINDOWS, SuccessModel, isPeak, toIstParts } from '@mandate/core';
import type { Bucket, Method, Prediction } from '@mandate/core';
import { query } from '@mandate/db';
import { loadOutcomes } from '../planner.ts';

export interface TraceStep {
  stage: string;
  headline: string;
  detail: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface Counterfactual {
  default_at: string;
  default_in_peak: boolean;
  default_p: number;
  default_evidence: number;
  chosen_at: string | null;
  chosen_in_peak: boolean;
  chosen_p: number;
  chosen_evidence: number;
  edge: number;
  verdict: string;
}

export interface DecisionTrace {
  decision_id: string;
  subscription_id: string;
  customer_ref: string;
  merchant_id: string;
  amount_paise: number;
  arm: string | null;
  steps: TraceStep[];
  counterfactual: Counterfactual | null;
  outcome: string | null;
  headline: string;
}

interface Row {
  id: string;
  subscription_id: string;
  customer_ref: string;
  merchant_id: string;
  amount_paise: string;
  method: Method;
  cycle: Date;
  proposed_action: string;
  proposed_by: string;
  prompt_version: string | null;
  confidence: number | null;
  verdict: string;
  rule_id: string;
  scheduled_for: Date | null;
  proposed_for: Date | null;
  rationale: string | null;
  explanation: string | null;
  agent_context: Record<string, unknown> | null;
  taxonomy_version: string | null;
  expected_paise: string | null;
  slots_considered: number | null;
  explored: boolean;
  logging_propensity: string | null;
  created_at: Date;
  executed_at: Date | null;
  outcome: string | null;
  arm: string | null;
}

interface FailureRow {
  attempted_at: Date;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  bucket: string | null;
  issuer: string | null;
  taxonomy_version: string | null;
}

const DECISION_SQL = `
  SELECT d.id::text AS id, d.subscription_id, s.customer_ref, s.merchant_id,
         s.amount_paise::text AS amount_paise, s.method, d.cycle,
         d.proposed_action, d.proposed_by, d.prompt_version, d.confidence::float8 AS confidence,
         d.verdict, d.rule_id, d.scheduled_for, d.proposed_for, d.rationale, d.explanation,
         d.agent_context, d.taxonomy_version, d.expected_paise::text AS expected_paise,
         d.slots_considered, d.explored, d.logging_propensity::text AS logging_propensity,
         d.created_at, d.executed_at, d.outcome, a.arm
    FROM decision d
    JOIN subscription s ON s.id = d.subscription_id
    LEFT JOIN arm_assignment a ON a.subscription_id = d.subscription_id
   WHERE d.id = $1`;

const FAILURE_SQL = `
  SELECT pa.attempted_at, pa.error_reason, pa.error_source, pa.error_step,
         pa.bucket, pa.issuer, pa.taxonomy_version
    FROM payment_attempt pa
   WHERE pa.subscription_id = $1 AND pa.cycle = $2 AND pa.status = 'failed'
   ORDER BY pa.attempted_at
   LIMIT 1`;

function ist(d: Date | null): string {
  if (!d) return 'not scheduled';
  const p = toIstParts(d);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${hh}:${mm} IST`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function buildDecisionTrace(decisionId: string): Promise<DecisionTrace | null> {
  const { rows } = await query<Row>(DECISION_SQL, [decisionId]);
  const d = rows[0];
  if (!d) return null;

  const { rows: failures } = await query<FailureRow>(FAILURE_SQL, [d.subscription_id, d.cycle]);
  const failure = failures[0];
  const ctx = d.agent_context ?? {};
  const amount = Number(d.amount_paise);
  const steps: TraceStep[] = [];

  const bucket = (failure?.bucket ?? (ctx['bucket'] as string) ?? 'UNKNOWN') as Bucket;
  const issuer = failure?.issuer ?? (ctx['issuer'] as string | null) ?? null;

  steps.push({
    stage: 'The failure',
    headline: failure?.error_reason
      ? `Declined: ${failure.error_reason}`
      : 'A charge on this mandate failed',
    detail: failure
      ? `Razorpay reported ${failure.error_reason ?? 'no reason'} from ${failure.error_source ?? 'an unstated source'}${failure.error_step ? ` at ${failure.error_step}` : ''}.`
      : 'The originating failure is no longer in the retained window.',
    facts: {
      failed_at: failure ? ist(failure.attempted_at) : null,
      error_reason: failure?.error_reason ?? null,
      error_source: failure?.error_source ?? null,
      issuer,
    },
  });

  steps.push({
    stage: 'Diagnosis',
    headline: `Classified ${bucket}`,
    detail: bucket === 'UNKNOWN'
      ? 'This decline code is not in the taxonomy, so it gets the conservative path and is counted on the honesty metric.'
      : `The taxonomy maps this reason to ${bucket}, which decides whether a retry can help at all.`,
    facts: {
      bucket,
      taxonomy_version: failure?.taxonomy_version ?? d.taxonomy_version ?? null,
      verified: false,
    },
  });

  const contributions = (ctx['contributions'] ?? {}) as Record<string, number>;
  steps.push({
    stage: 'Risk',
    headline: `Health score ${typeof ctx['risk_score'] === 'number' ? (ctx['risk_score'] as number).toFixed(2) : 'n/a'} (${(ctx['risk_band'] as string) ?? 'unknown'})`,
    detail: 'The score is a weighted sum, and every term is shown so it can be argued with.',
    facts: Object.fromEntries(Object.entries(contributions).map(([k, v]) => [k, v])),
  });

  const liquidity = (ctx['liquidity_window'] ?? {}) as Record<string, unknown>;
  steps.push({
    stage: 'When money arrives',
    headline: liquidity['tier'] === 'population_default'
      ? 'No personal history, using the population default'
      : `Inferred from this customer, tier ${String(liquidity['tier'] ?? 'unknown')}`,
    detail: 'A liquidity window is only trusted when there is enough of the customer\'s own history behind it.',
    facts: {
      tier: (liquidity['tier'] as string) ?? null,
      confidence: typeof liquidity['confidence'] === 'number' ? liquidity['confidence'] as number : null,
      window_days: Array.isArray(liquidity['window_days'])
        ? (liquidity['window_days'] as number[]).join(', ')
        : null,
    },
  });

  steps.push({
    stage: 'The allocator',
    headline: d.slots_considered
      ? `Ranked ${d.slots_considered} candidate times`
      : 'Chose an action from the remaining budget',
    detail: 'Attempts are a fixed budget set by the payment network, so the allocator maximises expected recovery per attempt rather than total attempts.',
    facts: {
      slots_considered: d.slots_considered,
      expected_paise: d.expected_paise ? Number(d.expected_paise) : null,
      explored: d.explored,
      logging_propensity: d.logging_propensity ? Number(d.logging_propensity) : null,
    },
  });

  steps.push({
    stage: 'The agent',
    headline: `${d.proposed_by} proposed ${d.proposed_action}`,
    detail: d.rationale ?? 'No rationale was recorded.',
    facts: {
      proposed_by: d.proposed_by,
      prompt_version: d.prompt_version,
      confidence: d.confidence,
      proposed_for: d.proposed_for ? ist(d.proposed_for) : null,
    },
  });

  const moved = d.proposed_for && d.scheduled_for
    && d.proposed_for.getTime() !== d.scheduled_for.getTime();

  steps.push({
    stage: 'The policy engine',
    headline: `${d.verdict} · ${d.rule_id}`,
    detail: d.explanation ?? 'No explanation was recorded.',
    facts: {
      verdict: d.verdict,
      rule_id: d.rule_id,
      scheduled_for: d.scheduled_for ? ist(d.scheduled_for) : null,
      moved_by_policy: Boolean(moved),
    },
  });

  steps.push({
    stage: 'What happened',
    headline: d.outcome
      ? `Outcome: ${d.outcome}`
      : d.executed_at ? 'Executed, awaiting settlement' : 'Not executed yet',
    detail: d.verdict === 'DENY'
      ? 'The action was refused, so no money moved and no attempt was spent.'
      : 'Every execution carries an idempotency key, so this can never run twice.',
    facts: {
      executed_at: d.executed_at ? ist(d.executed_at) : null,
      outcome: d.outcome,
      arm: d.arm,
    },
  });

  let counterfactual: Counterfactual | null = null;

  if (failure && d.scheduled_for && d.proposed_action === 'RETRY_SCHEDULED') {
    const model = new SuccessModel(await loadOutcomes());
    const defaultAt = new Date(failure.attempted_at.getTime() + 86_400_000);

    const slotFor = (at: Date): Parameters<SuccessModel['predict']>[0] => ({
      bucket,
      issuer,
      method: d.method,
      day_of_month: toIstParts(at).day,
      hour: toIstParts(at).hour,
      days_since_failure: (at.getTime() - failure.attempted_at.getTime()) / 86_400_000,
      amount_paise: amount,
    });

    const dflt: Prediction = model.predict(slotFor(defaultAt));
    const ours: Prediction = model.predict(slotFor(d.scheduled_for));
    const edge = ours.p - dflt.p;

    counterfactual = {
      default_at: ist(defaultAt),
      default_in_peak: isPeak(defaultAt),
      default_p: dflt.p,
      default_evidence: dflt.evidence,
      chosen_at: ist(d.scheduled_for),
      chosen_in_peak: isPeak(d.scheduled_for),
      chosen_p: ours.p,
      chosen_evidence: ours.evidence,
      edge,
      verdict: Math.abs(edge) < 0.01
        ? 'No material difference from the default schedule on this mandate.'
        : edge > 0
          ? `Chose a slot the model rates ${pct(edge)} better than T+1.`
          : `Chose a slot the model rates ${pct(-edge)} worse than T+1, for a reason outside the model.`,
    };
  }

  const headline = d.verdict === 'DENY'
    ? `Refused by ${d.rule_id}: ${d.explanation ?? 'no explanation'}`
    : counterfactual
      ? `${d.proposed_action} at ${counterfactual.chosen_at}. ${counterfactual.verdict}`
      : `${d.proposed_action}, allowed by ${d.rule_id}.`;

  return {
    decision_id: d.id,
    subscription_id: d.subscription_id,
    customer_ref: d.customer_ref,
    merchant_id: d.merchant_id,
    amount_paise: amount,
    arm: d.arm,
    steps,
    counterfactual,
    outcome: d.outcome,
    headline,
  };
}

export const PEAK_WINDOW_LABEL = PEAK_WINDOWS
  .map(([s, e]) => `${String(Math.floor(s / 60)).padStart(2, '0')}:00–${String(Math.floor(e / 60)).padStart(2, '0')}:00`)
  .join(' and ');
