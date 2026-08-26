import type { Action, Bucket, Method, Proposal } from './types.ts';

export const PROMPT_VERSION = '0.1.0';

export const VALID_ACTIONS: readonly Action[] = [
  'RETRY_SCHEDULED',
  'HOLD',
  'REAUTH_OUTREACH',
  'STOP',
];

export interface MandateContext {
  subscription_id: string;
  method: Method;
  amount_paise: number;
  cycle_start: string;
  cycle_end: string | null;
  mandate_expiry_at: string | null;
  days_to_expiry: number | null;

  error_code: string | null;
  error_reason: string | null;
  error_source: string | null;
  error_step: string | null;
  bucket: Bucket;
  bucket_confidence: string;
  taxonomy_version: string;

  risk_band: string;
  risk_score: number;
  consecutive_failures: number;
  attempts_remaining: number;
  contributions: Record<string, number>;

  liquidity_window: {
    preferred_day: number | null;
    window_days: [number, number] | null;
    confidence: number;
    tier: 'own_history' | 'merchant_default' | 'population_default';
  } | null;

  issuer: string | null;
  issuer_degraded: boolean;
  degradation_source: string | null;

  successful_payment_days: number[];
  now: string;
  earliest_legal_slot: string;
}

export type ValidationResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; error: string };

export function validateProposal(raw: unknown, subscriptionId: string): ValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'response was not a JSON object' };
  }

  const value = raw as Record<string, unknown>;
  const action = value['action'];

  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as Action)) {
    return { ok: false, error: `action ${JSON.stringify(action)} is not in the allowed set` };
  }

  const reason = value['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, error: 'reason must be a non-empty string' };
  }

  const confidence = value['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: 'confidence must be a number between 0 and 1' };
  }

  const scheduledFor = value['scheduled_for'];

  if (action === 'RETRY_SCHEDULED') {
    if (typeof scheduledFor !== 'string') {
      return { ok: false, error: 'RETRY_SCHEDULED requires a scheduled_for string' };
    }
    if (Number.isNaN(new Date(scheduledFor).getTime())) {
      return { ok: false, error: 'scheduled_for is not a valid timestamp' };
    }
    return {
      ok: true,
      proposal: {
        subscription_id: subscriptionId,
        action,
        scheduled_for: scheduledFor,
        reason: reason.trim(),
        confidence,
      },
    };
  }

  if (scheduledFor !== undefined && scheduledFor !== null) {
    return { ok: false, error: `${action} must not carry scheduled_for` };
  }

  return {
    ok: true,
    proposal: {
      subscription_id: subscriptionId,
      action: action as Action,
      reason: reason.trim(),
      confidence,
    },
  };
}

export function buildPrompt(ctx: MandateContext): string {
  const lines = [
    'A recurring mandate has failed and is inside the window before it halts.',
    'Propose one intervention. Facts follow.',
    '',
    '## Subscription',
    `method: ${ctx.method}`,
    `amount_paise: ${ctx.amount_paise}`,
    `cycle: ${ctx.cycle_start} to ${ctx.cycle_end ?? 'unknown'}`,
    `mandate_expiry: ${ctx.mandate_expiry_at ?? 'none recorded'}`,
    `days_to_expiry: ${ctx.days_to_expiry ?? 'unknown'}`,
    '',
    '## The failure',
    `error_code: ${ctx.error_code ?? 'null'}`,
    `error_reason: ${ctx.error_reason ?? 'null'}`,
    `error_source: ${ctx.error_source ?? 'null'}`,
    `error_step: ${ctx.error_step ?? 'null'}`,
    `classified_as: ${ctx.bucket} (confidence ${ctx.bucket_confidence}, taxonomy ${ctx.taxonomy_version})`,
    '',
    '## Mandate health',
    `risk_band: ${ctx.risk_band}`,
    `risk_score: ${ctx.risk_score}`,
    `consecutive_failures: ${ctx.consecutive_failures}`,
    `attempts_remaining: ${ctx.attempts_remaining}`,
    `score_contributions: ${JSON.stringify(ctx.contributions)}`,
    '',
    '## Timing',
    `now: ${ctx.now}`,
    `earliest_legal_slot: ${ctx.earliest_legal_slot}`,
    ctx.liquidity_window
      ? `liquidity_window: day ${ctx.liquidity_window.preferred_day ?? 'unknown'}, ` +
        `range ${JSON.stringify(ctx.liquidity_window.window_days)}, ` +
        `confidence ${ctx.liquidity_window.confidence}, derived from ${ctx.liquidity_window.tier}`
      : 'liquidity_window: not inferred, no successful payment history',
    `prior_successful_payment_days_of_month: ${JSON.stringify(ctx.successful_payment_days)}`,
    '',
    '## Issuer',
    `issuer: ${ctx.issuer ?? 'unknown'}`,
    `degraded: ${ctx.issuer_degraded}${ctx.degradation_source ? ` (source: ${ctx.degradation_source})` : ''}`,
  ];

  return lines.join('\n');
}

export const SYSTEM_PROMPT = [
  'You decide how to spend a failing subscription mandate\'s remaining attempts.',
  '',
  'The mandate has a small, fixed number of attempts before it is cancelled permanently.',
  'Spending one on a failure that cannot succeed is the expensive mistake, not waiting.',
  '',
  'Choose exactly one action:',
  '',
  '- RETRY_SCHEDULED: attempt the charge at a specific time. Only worth doing when the',
  '  failure was transient or a funding shortfall, and the timing gives it a better chance',
  '  than the last attempt had. Pick a time from the liquidity window when one exists and',
  '  its confidence supports it; otherwise pick the earliest legal slot.',
  '- HOLD: spend nothing now. Correct when the rails are unwell and waiting costs less',
  '  than an attempt.',
  '- REAUTH_OUTREACH: the instrument is dead or unusable, so no retry can work and the',
  '  only path is a fresh authorization from the customer.',
  '- STOP: the customer has declined permanently, or nothing further is worth spending.',
  '',
  'Timing rules you must respect: an attempt cannot be scheduled before the stated',
  'earliest_legal_slot. A time you propose may still be moved by downstream checks.',
  '',
  'The reason field is shown to the merchant who owns this subscription. Write one plain',
  'sentence explaining the decision in terms of what happened and what you expect. Do not',
  'mention rules, systems, or confidence scores in it, and never state a rupee figure.',
  '',
  'Confidence is your own estimate of whether this action is the right one. It is used for',
  'ranking and review, never to authorise anything.',
].join('\n');

export interface ProposalClient {
  propose(ctx: MandateContext): Promise<ProposalOutcome>;
}

export type ProposalOutcome =
  | { ok: true; proposal: Proposal; model: string; prompt_version: string; raw: unknown }
  | { ok: false; error: string; model: string; prompt_version: string; raw: unknown };
