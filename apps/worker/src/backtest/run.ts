import {
  NPCI_ATTEMPT_BUDGET,
  TAXONOMY_VERSION,
  classify,
  evaluate,
  inferLiquidityWindow,
  isHard,
  score,
} from '@mandate/core';
import { isPeak } from '@mandate/core';
import type { Bucket, PolicyContext, Proposal } from '@mandate/core';
import { config } from '../config.ts';
import { AsOfLoader, loadHistory, subsequentAttempts } from './loader.ts';
import type { HistoricalAttempt } from './loader.ts';

export interface DecisionPoint {
  subscription_id: string;
  cycle: Date;
  attempted_at: Date;
  amount_paise: number;
  error_reason: string | null;
  bucket: Bucket;
  our_action: Proposal['action'];
  our_verdict: string;
  our_rule_id: string;
  liquidity_tier: string;
  liquidity_confidence: number;
  default_attempts_after: number;
  default_recovered: boolean;
  default_wasted_attempts: number;
  default_attempts_in_peak: number;
  rescheduled: boolean;
}

export interface BacktestResult {
  taxonomy_version: string;
  generated_at: Date;
  decision_points: DecisionPoint[];
  totals: {
    failures_examined: number;
    subscriptions: number;
    amount_at_risk_paise: number;
    default_attempts_spent: number;
    default_attempts_on_hard_declines: number;
    our_attempts_authorised: number;
    our_attempts_rescheduled: number;
    default_attempts_in_peak_windows: number;
    our_refusals_by_rule: Record<string, number>;
    attempts_we_would_not_have_spent: number;
    amount_recovered_by_default_paise: number;
    liquidity_tiers: Record<string, number>;
    unmapped_failures: number;
  };
}

function proposeFromBucket(bucket: Bucket, scheduledFor: string): Proposal {
  const base = { subscription_id: '', reason: 'deterministic backtest proposer', confidence: 1 };
  if (bucket === 'HARD_INSTRUMENT') return { ...base, action: 'REAUTH_OUTREACH' };
  if (bucket === 'HARD_CUSTOMER') return { ...base, action: 'STOP' };
  if (bucket === 'SOFT_TRANSIENT' || bucket === 'SOFT_LIQUIDITY' || bucket === 'UNKNOWN') {
    return { ...base, action: 'RETRY_SCHEDULED', scheduled_for: scheduledFor };
  }
  return { ...base, action: 'HOLD' };
}

export async function runBacktest(merchantId?: string): Promise<BacktestResult> {
  const history = await loadHistory(merchantId);
  const failures = history.filter((h) => h.status === 'failed');

  const points: DecisionPoint[] = [];
  const refusals: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  const subscriptions = new Set<string>();

  let defaultAttemptsSpent = 0;
  let defaultOnHard = 0;
  let ourAuthorised = 0;
  let ourRescheduled = 0;
  let defaultInPeak = 0;
  let notSpent = 0;
  let recovered = 0;
  let atRisk = 0;
  let unmapped = 0;

  for (const failure of failures) {
    const loader = new AsOfLoader(failure.attempted_at);
    const prior = await loader.priorState(failure.subscription_id, failure.cycle);

    const classification = classify(failure, failure.method);
    if (classification.bucket === 'UNKNOWN') unmapped += 1;

    const health = score({
      now: failure.attempted_at,
      consecutive_failures: prior.failures_before + 1,
      attempts_used_this_cycle: prior.attempts_before + 1,
      mandate_expiry_at: failure.mandate_expiry_at,
      soft_decline_rate: 0,
      issuer_degraded: false,
      method: failure.method,
      last_bucket: classification.bucket,
    });

    const liquidity = inferLiquidityWindow(prior.success_days);
    tiers[liquidity.tier] = (tiers[liquidity.tier] ?? 0) + 1;

    const scheduledFor = new Date(failure.attempted_at.getTime() + 26 * 3600 * 1000).toISOString();
    const proposal = {
      ...proposeFromBucket(classification.bucket, scheduledFor),
      subscription_id: failure.subscription_id,
    };

    const ctx: PolicyContext = {
      now: failure.attempted_at,
      kill_switch: false,
      write_enabled: true,
      subscription_status: 'pending',
      method: failure.method,
      amount_paise: failure.amount_paise,
      cycle: failure.cycle,
      mandate_expiry_at: failure.mandate_expiry_at,
      cycle_already_paid: prior.captured_before,
      attempts_remaining: Math.max(0, NPCI_ATTEMPT_BUDGET - (prior.attempts_before + 1)),
      attempt_number: prior.attempts_before + 2,
      last_bucket: classification.bucket,
      consecutive_soft_cycles: 0,
      max_soft_cycles: config.maxSoftCycles,
      attempt_exists: false,
      attempt_in_flight: false,
      issuer_degraded: false,
      contacts_this_cycle: 0,
      max_contacts_per_cycle: 1,
      blast_attempts_used: 0,
      blast_attempts_max: Number.MAX_SAFE_INTEGER,
    };

    const verdict = evaluate(proposal, ctx);

    const after = await subsequentAttempts(failure.subscription_id, failure.cycle, failure.attempted_at);
    const defaultAttempts = after.filter((a) => a.initiated_by === 'razorpay_default').length;
    const defaultRecovered = after.some((a) => a.status === 'captured');
    const wasted = isHard(classification.bucket) ? defaultAttempts : 0;

    subscriptions.add(failure.subscription_id);
    defaultAttemptsSpent += defaultAttempts;
    defaultOnHard += wasted;
    atRisk += failure.amount_paise;
    if (defaultRecovered) recovered += failure.amount_paise;

    const timingAdjusted = verdict.verdict === 'DEFER' &&
      (verdict.rule_id === 'R-PDN' || verdict.rule_id === 'R-WINDOW');
    const authorised = proposal.action === 'RETRY_SCHEDULED' &&
      (verdict.verdict === 'ALLOW' || timingAdjusted);

    if (authorised) {
      ourAuthorised += 1;
      if (timingAdjusted) ourRescheduled += 1;
    } else {
      refusals[verdict.rule_id] = (refusals[verdict.rule_id] ?? 0) + 1;
      if (proposal.action !== 'RETRY_SCHEDULED') notSpent += defaultAttempts;
    }

    const inPeak = after.filter(
      (a) => a.initiated_by === 'razorpay_default' && isPeak(a.attempted_at),
    ).length;
    defaultInPeak += inPeak;

    points.push({
      subscription_id: failure.subscription_id,
      cycle: failure.cycle,
      attempted_at: failure.attempted_at,
      amount_paise: failure.amount_paise,
      error_reason: failure.error_reason,
      bucket: classification.bucket,
      our_action: proposal.action,
      our_verdict: verdict.verdict,
      our_rule_id: verdict.rule_id,
      liquidity_tier: liquidity.tier,
      liquidity_confidence: liquidity.confidence,
      default_attempts_after: defaultAttempts,
      default_recovered: defaultRecovered,
      default_wasted_attempts: wasted,
      default_attempts_in_peak: inPeak,
      rescheduled: timingAdjusted,
    });
  }

  return {
    taxonomy_version: TAXONOMY_VERSION,
    generated_at: new Date(),
    decision_points: points,
    totals: {
      failures_examined: failures.length,
      subscriptions: subscriptions.size,
      amount_at_risk_paise: atRisk,
      default_attempts_spent: defaultAttemptsSpent,
      default_attempts_on_hard_declines: defaultOnHard,
      our_attempts_authorised: ourAuthorised,
      our_attempts_rescheduled: ourRescheduled,
      default_attempts_in_peak_windows: defaultInPeak,
      our_refusals_by_rule: refusals,
      attempts_we_would_not_have_spent: notSpent,
      amount_recovered_by_default_paise: recovered,
      liquidity_tiers: tiers,
      unmapped_failures: unmapped,
    },
  };
}
