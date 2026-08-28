import {
  PDN_MIN_LEAD_MS,
  PEAK_WINDOWS,
  SuccessModel,
  addMs,
  fromIst,
  isPeak,
  planRecovery,
  toIstParts,
} from '@mandate/core';
import { exploreAmong } from '@mandate/core';
import type { Bucket, CandidateSlot, Method, Outcome, Plan, Proposal, RankedSlot } from '@mandate/core';
import { query } from '@mandate/db';

const CANDIDATE_HOURS = [8, 14, 15, 22];
const MAX_HORIZON_DAYS = 21;

export interface PlanRequest {
  subscription_id: string;
  bucket: Bucket;
  issuer: string | null;
  method: Method;
  amount_paise: number;
  attempts_remaining: number;
  days_to_halt: number;
  last_failure_at: Date;
  reauth_available: boolean;
  remaining_cycles: number;
  now: Date;
}

export async function loadOutcomes(merchantId?: string): Promise<Outcome[]> {
  const { rows } = await query<Outcome>(
    `SELECT
       COALESCE(pa.bucket, 'UNKNOWN') AS bucket,
       pa.issuer,
       s.method,
       EXTRACT(DAY  FROM pa.attempted_at AT TIME ZONE 'Asia/Kolkata')::int AS day_of_month,
       EXTRACT(HOUR FROM pa.attempted_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
       COALESCE(EXTRACT(EPOCH FROM (pa.attempted_at - prev.attempted_at)) / 86400.0, 0)::float8
         AS days_since_failure,
       pa.amount_paise,
       (pa.status = 'captured') AS succeeded
     FROM payment_attempt pa
     JOIN subscription s ON s.id = pa.subscription_id
     LEFT JOIN LATERAL (
       SELECT attempted_at FROM payment_attempt p2
        WHERE p2.subscription_id = pa.subscription_id
          AND p2.status = 'failed'
          AND p2.attempted_at < pa.attempted_at
        ORDER BY p2.attempted_at DESC LIMIT 1
     ) prev ON TRUE
     WHERE pa.status IN ('captured','failed')
       AND ($1::text IS NULL OR s.merchant_id = $1)`,
    [merchantId ?? null],
  );
  return rows;
}

export function candidateSlots(req: PlanRequest): CandidateSlot[] {
  const floor = addMs(req.now, PDN_MIN_LEAD_MS);
  const horizon = Math.min(MAX_HORIZON_DAYS, Math.max(0, Math.floor(req.days_to_halt)));
  const slots: CandidateSlot[] = [];

  for (let dayOffset = 0; dayOffset <= horizon; dayOffset += 1) {
    const base = addMs(req.now, dayOffset * 86_400_000);
    const p = toIstParts(base);

    for (const hour of CANDIDATE_HOURS) {
      const at = fromIst(p.year, p.month, p.day, hour * 60);
      if (at < floor) continue;
      if (isPeak(at)) continue;

      const ist = toIstParts(at);
      slots.push({
        at,
        days_from_now: Math.floor((at.getTime() - req.now.getTime()) / 86_400_000),
        slot: {
          bucket: req.bucket,
          issuer: req.issuer,
          method: req.method,
          day_of_month: ist.day,
          hour: ist.hour,
          days_since_failure: (at.getTime() - req.last_failure_at.getTime()) / 86_400_000,
          amount_paise: req.amount_paise,
        },
      });
    }
  }

  return slots;
}

export function planToProposal(plan: Plan, subscriptionId: string): Proposal {
  const confidence = plan.schedule[0]?.p_success ?? 0.5;

  if (plan.action === 'RETRY' && plan.at) {
    return {
      subscription_id: subscriptionId,
      action: 'RETRY_SCHEDULED',
      scheduled_for: plan.at.toISOString(),
      reason: plan.reason,
      confidence: round(confidence),
    };
  }
  if (plan.action === 'REAUTH') {
    return {
      subscription_id: subscriptionId,
      action: 'REAUTH_OUTREACH',
      reason: plan.reason,
      confidence: round(confidence),
    };
  }
  if (plan.action === 'WAIT') {
    return {
      subscription_id: subscriptionId,
      action: 'HOLD',
      reason: plan.reason,
      confidence: round(confidence),
    };
  }
  return {
    subscription_id: subscriptionId,
    action: 'STOP',
    reason: plan.reason,
    confidence: round(confidence),
  };
}

export function buildPlan(req: PlanRequest, model: SuccessModel): Plan {
  return planRecovery(
    {
      amount_paise: req.amount_paise,
      mandate_lifetime_paise: req.amount_paise * Math.max(0, req.remaining_cycles),
      attempts_remaining: req.attempts_remaining,
      days_to_halt: Math.min(MAX_HORIZON_DAYS, Math.max(0, Math.floor(req.days_to_halt))),
      candidates: candidateSlots(req),
      reauth_conversion: 0.25,
      reauth_value_fraction: 0.85,
      reauth_available: req.reauth_available,
      reauth_decay_per_attempt: 0.75,
    },
    model,
  );
}

export function peakWindowsIst(): ReadonlyArray<readonly [number, number]> {
  return PEAK_WINDOWS;
}

function round(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

export interface ExploredPlan {
  plan: Plan;
  chosen_at: Date | null;
  logging_propensity: number;
  target_propensity: number;
  explored: boolean;
  slots_considered: number;
}

export function explorePlan(plan: Plan, epsilon: number, draw: number): ExploredPlan {
  const ranked: RankedSlot[] = plan.ranked_slots;

  if (plan.action !== 'RETRY' || ranked.length === 0) {
    return {
      plan,
      chosen_at: plan.at,
      logging_propensity: 1,
      target_propensity: 1,
      explored: false,
      slots_considered: ranked.length,
    };
  }

  const choice = exploreAmong(ranked, epsilon, draw);
  if (!choice) {
    return {
      plan,
      chosen_at: plan.at,
      logging_propensity: 1,
      target_propensity: 1,
      explored: false,
      slots_considered: 0,
    };
  }

  const isBest = choice.chosen.at.getTime() === ranked[0]!.at.getTime();

  return {
    plan: { ...plan, at: choice.chosen.at },
    chosen_at: choice.chosen.at,
    logging_propensity: choice.propensity,
    target_propensity: isBest ? 1 : 0,
    explored: !isBest,
    slots_considered: choice.considered,
  };
}
