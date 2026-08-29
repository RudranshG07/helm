import type { PolicyContext, PolicyVerdict, Proposal } from './types.ts';
import { isHard } from './taxonomy.ts';
import {
  PDN_CUTOFF_MINUTE,
  PDN_MIN_LEAD_MS,
  addMs,
  isNextIstDay,
  isPeak,
  snapOutOfPeak,
  toIstParts,
} from './time.ts';

export const AFA_THRESHOLD_PAISE = 1_500_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const deny = (rule_id: string, explanation: string): PolicyVerdict => ({
  verdict: 'DENY',
  rule_id,
  explanation,
});

const defer = (rule_id: string, explanation: string, extra: Partial<PolicyVerdict> = {}): PolicyVerdict => ({
  verdict: 'DEFER',
  rule_id,
  explanation,
  ...extra,
});

export type Phase = 'proposal' | 'execution';

export interface EvaluateOptions {
  phase?: Phase;
}

export function evaluate(
  proposal: Proposal,
  ctx: PolicyContext,
  options: EvaluateOptions = {},
): PolicyVerdict {
  const phase = options.phase ?? 'proposal';
  if (!proposal || typeof proposal !== 'object') {
    return defer('R-MALFORMED', 'Proposal was not an object.');
  }

  if (ctx.kill_switch) {
    return deny('R-KILL', 'Global kill switch is engaged; all execution is halted.');
  }

  const isWrite = proposal.action === 'RETRY_SCHEDULED';
  const isContact = proposal.action === 'REAUTH_OUTREACH';

  if ((isWrite || isContact) && !ctx.write_enabled) {
    return deny('R-CONSENT', 'Merchant has not granted write access.');
  }

  if (proposal.action === 'HOLD' || proposal.action === 'STOP') {
    return {
      verdict: 'ALLOW',
      rule_id: 'R-OK',
      explanation: `${proposal.action} takes no external action.`,
    };
  }

  if (ctx.subscription_status === 'halted') {
    return deny('R-HALT', 'Subscription is already halted; no attempt is possible.');
  }
  if (['cancelled', 'completed', 'expired'].includes(ctx.subscription_status)) {
    return deny('R-HALT', `Subscription is ${ctx.subscription_status}; no attempt is possible.`);
  }

  if (ctx.mandate_expiry_at) {
    if (ctx.mandate_expiry_at <= ctx.now) {
      return deny('R-EXPIRY', 'Mandate has already expired.');
    }
    if (isWrite && proposal.scheduled_for) {
      const target = new Date(proposal.scheduled_for);
      if (!Number.isNaN(target.getTime()) && target >= ctx.mandate_expiry_at) {
        return deny('R-EXPIRY', 'Mandate expires before the proposed attempt time.');
      }
    }
  }

  if (ctx.cycle_already_paid) {
    return deny('R-PAID', 'This billing cycle has already been paid; no attempt is owed.');
  }

  if (ctx.last_bucket && isHard(ctx.last_bucket)) {
    if (isWrite) {
      return deny('R-HARD', `Last decline was ${ctx.last_bucket}; retrying cannot succeed.`);
    }
    if (ctx.last_bucket === 'HARD_CUSTOMER') {
      return deny('R-HARD', 'Customer declined permanently; no further contact.');
    }
  }

  if (
    isWrite &&
    ctx.max_soft_cycles > 0 &&
    ctx.consecutive_soft_cycles >= ctx.max_soft_cycles
  ) {
    return deny(
      'R-CHRONIC',
      `Soft declines have repeated across ${ctx.consecutive_soft_cycles} cycles; further retries are not recovering this mandate.`,
    );
  }

  if (isWrite) {
    if (ctx.method === 'card' && ctx.integration === 'subscriptions') {
      return deny(
        'R-METHOD',
        'Razorpay does not support manually charging a domestic card on a subscription invoice.',
      );
    }
    if (ctx.amount_paise > AFA_THRESHOLD_PAISE) {
      return deny('R-METHOD', 'Amount exceeds the additional-authentication threshold; no silent retry is possible.');
    }
    if (!(ctx.attempts_remaining > 0)) {
      return deny('R-BUDGET', 'Attempt budget for this cycle is exhausted.');
    }
    if (ctx.attempt_exists) {
      return deny('R-IDEMPOTENT', 'An attempt already exists for this subscription, cycle and attempt number.');
    }
    if (ctx.attempt_in_flight) {
      return deny('R-IDEMPOTENT', 'A previous attempt for this cycle is submitted but not yet settled.');
    }
  }

  if (isContact) {
    if (ctx.contacts_this_cycle >= ctx.max_contacts_per_cycle) {
      return deny('R-CONTACT', 'Outreach cap for this customer this cycle has been reached.');
    }
    return {
      verdict: 'ALLOW',
      rule_id: 'R-OK',
      explanation: 'Re-authorization outreach is within the contact cap.',
    };
  }

  if (!proposal.scheduled_for) {
    return defer('R-MALFORMED', 'RETRY_SCHEDULED requires scheduled_for.');
  }

  const proposed = new Date(proposal.scheduled_for);
  if (Number.isNaN(proposed.getTime()) && phase === 'execution') {
    return defer('R-MALFORMED', 'scheduled_for is not a valid timestamp.');
  }
  if (Number.isNaN(proposed.getTime())) {
    return defer('R-MALFORMED', 'scheduled_for is not a valid timestamp.');
  }
  const proposed_for = proposed.toISOString();

  if (phase === 'execution') {
    if (ctx.blast_attempts_used >= ctx.blast_attempts_max) {
      return deny('R-BLAST', 'Blast-radius cap for this run has been reached.');
    }
    if (ctx.issuer_degraded) {
      return defer('R-DEGRADED', 'Issuer or method is currently degraded; holding rather than spending an attempt.', {
        proposed_for,
      });
    }
    return {
      verdict: 'ALLOW',
      rule_id: 'R-OK',
      scheduled_for: proposed.toISOString(),
      proposed_for,
      explanation: 'All bounds still satisfied at execution time.',
    };
  }

  let target = proposed;
  let adjusted = false;

  const floor = addMs(ctx.now, PDN_MIN_LEAD_MS);
  if (target < floor) {
    target = floor;
    adjusted = true;
  }
  if (toIstParts(ctx.now).minuteOfDay >= PDN_CUTOFF_MINUTE && isNextIstDay(ctx.now, target)) {
    target = addMs(target, DAY_MS);
    adjusted = true;
  }
  if (adjusted) {
    return defer(
      'R-PDN',
      'Pre-debit notification requires at least 24 hours of lead time; moved to the earliest legal slot.',
      { scheduled_for: snapOutOfPeak(target).toISOString(), proposed_for },
    );
  }

  if (isPeak(target)) {
    return defer(
      'R-WINDOW',
      'Proposed time falls in a peak execution window; moved to the next permitted window.',
      { scheduled_for: snapOutOfPeak(target).toISOString(), proposed_for },
    );
  }

  if (ctx.issuer_degraded) {
    return defer('R-DEGRADED', 'Issuer or method is currently degraded; holding rather than spending an attempt.', {
      proposed_for,
    });
  }

  if (ctx.blast_attempts_used >= ctx.blast_attempts_max) {
    return deny('R-BLAST', 'Blast-radius cap for this run has been reached.');
  }

  return {
    verdict: 'ALLOW',
    rule_id: 'R-OK',
    scheduled_for: target.toISOString(),
    proposed_for,
    explanation: 'All bounds satisfied.',
  };
}

export const ALL_RULE_IDS = [
  'R-KILL', 'R-CONSENT', 'R-HALT', 'R-PAID', 'R-EXPIRY', 'R-HARD', 'R-CHRONIC', 'R-METHOD',
  'R-BUDGET', 'R-IDEMPOTENT', 'R-CONTACT', 'R-PDN', 'R-WINDOW',
  'R-DEGRADED', 'R-BLAST', 'R-MALFORMED', 'R-OK',
] as const;
