import { NPCI_ATTEMPT_BUDGET, SuccessModel, TAXONOMY_VERSION, evaluate } from '@mandate/core';
import type { Outcome, PolicyContext, Proposal } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { execute } from '../executor.ts';
import { buildPlan, planToProposal } from '../planner.ts';
import { log } from '../log.ts';
import { assignArm } from '../arms.ts';
import { SimulatedGateway } from './simulator.ts';
import type { GenerativeModel } from './simulator.ts';
import { generateMandates } from './run.ts';
import type { Mandate } from './run.ts';

export interface LiveBatchResult {
  merchant_id: string;
  mandates: number;
  amount_at_risk_paise: number;
  amount_recovered_paise: number;
  attempts_spent: number;
  mandates_recovered: number;
  intents_written: number;
  duplicates_blocked: number;
  policy_refusals: Record<string, number>;
  orders_created: number;
  decisions_recorded: number;
  pending_cohort: number;
  merchants: number;
  escalations: number;
  control_mandates: number;
  control_attempts: number;
  control_recovered_paise: number;
  control_mandates_recovered: number;
  treatment_mandates: number;
  treatment_attempts: number;
  exactly_once_held: boolean;
}

export interface LiveBatchOptions {
  count?: number;
  merchants?: number;
  seed?: number;
  model?: GenerativeModel;
  now?: Date;
  merchantId?: string;
}

const HARD_SHARE = 0.15;

export const DEMO_MERCHANT_NAMES = ['gym', 'tiffin', 'streaming'] as const;
export const SHARED_CUSTOMER_SHARE = 0.4;
export const SHARED_POOL_DIVISOR = 6;

export function merchantIdsFor(prefix: string, count?: number): string[] {
  const n: number = count ?? DEMO_MERCHANT_NAMES.length;
  return DEMO_MERCHANT_NAMES.slice(0, Math.max(1, n)).map((name) => `${prefix}_${name}`);
}

export function merchantForIndex(index: number, merchants: string[]): string {
  return merchants[index % merchants.length]!;
}

export const PENDING_SHARE = 0.25;

export async function seedPendingCohort(
  prefix: string,
  merchants: string[],
  count: number,
  now: Date,
): Promise<number> {
  if (count <= 0) return 0;

  await withTransaction(async (client) => {
    for (let i = 0; i < count; i += 1) {
      const merchantId = merchantForIndex(i, merchants);
      const id = `${prefix}:pending_${i}`;
      const customerKey = `ck_shared_${i % Math.max(1, Math.floor(count / 2))}`;
      const amount = 19900 + (i % 12) * 10000;
      const cycleStart = new Date(now.getTime() - 2 * 86_400_000);
      const cycleEnd = new Date(now.getTime() + 26 * 86_400_000);

      await client.query(
        `INSERT INTO subscription (
           id, merchant_id, rzp_subscription_id, customer_ref, customer_key, method,
           amount_paise, status, current_start, current_end, rzp_token_id, rzp_customer_id
         ) VALUES ($1,$2,$3,$3,$4,'upi_autopay',$5,'active',$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [id, merchantId, `pending_${i}`, customerKey, amount, cycleStart, cycleEnd,
         `token_pending_${i}`, `cust_pending_${i}`],
      );

      await client.query(
        `INSERT INTO payment_attempt (
           subscription_id, cycle, attempted_at, status, amount_paise,
           error_reason, error_source, bucket, issuer, initiated_by
         ) VALUES ($1,$2,$3,'failed',$4,'insufficient_funds','customer','SOFT_LIQUIDITY',$5,'razorpay_default')`,
        [id, cycleStart, new Date(now.getTime() - 3_600_000), amount,
         (['HDFC', 'ICIC', 'SBIN', 'UTIB'] as const)[i % 4]],
      );
    }
  });

  log.info('batch.pending_cohort', { prefix, count, merchants: merchants.length });
  return count;
}

export function customerKeyFor(index: number, total: number): string {
  const sharedCount = Math.floor(total * SHARED_CUSTOMER_SHARE);
  if (index >= sharedCount) return `ck_solo_${index}`;
  const pool = Math.max(1, Math.floor(sharedCount / SHARED_POOL_DIVISOR));
  return `ck_shared_${index % pool}`;
}

export function bucketFor(index: number): {
  bucket: 'SOFT_LIQUIDITY' | 'HARD_INSTRUMENT' | 'HARD_CUSTOMER';
  reason: string;
  source: string;
} {
  const slot = index % 20;
  if (slot === 3) return { bucket: 'HARD_INSTRUMENT', reason: 'invalid_vpa', source: 'customer' };
  if (slot === 11) return { bucket: 'HARD_CUSTOMER', reason: 'payment_cancelled', source: 'customer' };
  if (slot === 17) return { bucket: 'HARD_INSTRUMENT', reason: 'invalid_vpa', source: 'customer' };
  return { bucket: 'SOFT_LIQUIDITY', reason: 'insufficient_funds', source: 'customer' };
}

async function seedMandates(
  prefix: string,
  mandates: Mandate[],
  merchants: string[],
): Promise<void> {
  await withTransaction(async (client) => {
    for (const merchantId of merchants) {
      await client.query(
        `INSERT INTO merchant (id, name, mode, write_enabled, integration,
                               cross_merchant_signals, synthetic)
         VALUES ($1,$1,'test',TRUE,'recurring_tokens',TRUE,TRUE)
         ON CONFLICT (id) DO UPDATE SET write_enabled = TRUE, cross_merchant_signals = TRUE,
                                        synthetic = TRUE`,
        [merchantId],
      );
    }

    for (const [index, m] of mandates.entries()) {
      const merchantId = merchantForIndex(index, merchants);
      const id = `${prefix}:${m.id}`;
      const customerKey = customerKeyFor(index, mandates.length);
      await client.query(
        `INSERT INTO subscription (
           id, merchant_id, rzp_subscription_id, customer_ref, customer_key, method, amount_paise,
           status, current_start, current_end, rzp_token_id, rzp_customer_id,
           contact_email, contact_language
         ) VALUES ($1,$2,$3,$3,$9,'upi_autopay',$4,'pending',$5,$6,$7,$8,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [id, merchantId, m.id, m.amount_paise, m.cycle_start, m.cycle_end,
         `token_${m.id}`, `cust_${m.id}`, customerKey,
         `${m.id}@example.test`,
         (['en', 'hinglish', 'hi'] as const)[index % 3]],
      );

      const classification = bucketFor(index);
      await client.query(
        `INSERT INTO payment_attempt (
           subscription_id, cycle, attempted_at, status, amount_paise,
           error_reason, error_source, bucket, issuer, initiated_by
         ) VALUES ($1,$2,$3,'failed',$4,$6,$7,$8,$5,'razorpay_default')`,
        [id, m.cycle_start, m.first_failure_at, m.amount_paise, m.issuer,
         classification.reason, classification.source, classification.bucket],
      );
    }
  });
}

export async function cleanup(prefix: string): Promise<void> {
  const like = `${prefix}:%`;
  const merchantLike = `${prefix}\\_%`;
  await query(`DELETE FROM promise_to_pay WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM outreach WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM arm_assignment WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM execution_intent WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM decision WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM mandate_health WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id LIKE $1`, [like]);
  await query(`DELETE FROM subscription WHERE id LIKE $1`, [like]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1 OR merchant_id LIKE $2`,
    [prefix, merchantLike]);
  await query(`DELETE FROM merchant WHERE id = $1 OR id LIKE $2`, [prefix, merchantLike]);
}

async function recordDecision(
  subscriptionId: string,
  cycle: Date,
  proposal: Proposal,
  verdict: { verdict: string; rule_id: string; scheduled_for?: Date | string | null; explanation?: string },
  context: Record<string, unknown>,
): Promise<number | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO decision (
       subscription_id, cycle, proposed_action, proposed_by, confidence,
       verdict, rule_id, scheduled_for, proposed_for, rationale, explanation,
       agent_context, taxonomy_version
     ) VALUES ($1,$2,$3,'allocator',$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id::text AS id`,
    [
      subscriptionId, cycle, proposal.action, proposal.confidence ?? null,
      verdict.verdict, verdict.rule_id,
      verdict.scheduled_for ?? null, proposal.scheduled_for ?? null,
      proposal.reason ?? null, verdict.explanation ?? null,
      context, TAXONOMY_VERSION,
    ],
  );
  const id = rows[0]?.id;
  return id === undefined ? null : Number(id);
}

async function runControlArm(
  m: Mandate,
  subscriptionId: string,
  gateway: SimulatedGateway,
  now: Date,
): Promise<{ attempts: number; recovered: boolean }> {
  let attempts = 0;
  const start = m.first_failure_at > now ? m.first_failure_at : now;

  for (let day = 1; day < NPCI_ATTEMPT_BUDGET; day += 1) {
    const at = new Date(start.getTime() + day * 86_400_000);
    if (at >= m.cycle_end) break;

    const outcome = await execute(
      {
        decision_id: null,
        subscription_id: subscriptionId,
        rzp_subscription_id: m.id,
        cycle: m.cycle_start,
        attempt_number: attempts + 1,
        amount_paise: m.amount_paise,
        scheduled_for: at,
      },
      { gateway, dryRun: false, initiatedBy: 'razorpay_default' },
    );

    if (outcome.status === 'duplicate' || outcome.status === 'blocked') break;
    attempts += 1;

    if (outcome.status === 'executed' && outcome.payment?.status === 'captured') {
      return { attempts, recovered: true };
    }
  }

  return { attempts, recovered: false };
}

export async function runLiveBatch(options: LiveBatchOptions = {}): Promise<LiveBatchResult> {
  const count = options.count ?? 40;
  const seed = options.seed ?? 20260902;
  const now = options.now ?? new Date();
  const merchantId = options.merchantId ?? 'merchant_live_batch';

  const cycleStart = now;
  const cycleEnd = new Date(now.getTime() + 30 * 86_400_000);
  const mandates = generateMandates(count, seed, now).map((m) => ({
    ...m,
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    first_failure_at: now,
  }));
  const amounts = mandates.map((m) => m.amount_paise).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)] ?? 0;

  const merchants = merchantIdsFor(merchantId, options.merchants);

  await cleanup(merchantId);
  await seedMandates(merchantId, mandates, merchants);
  const pendingCohort = await seedPendingCohort(
    merchantId, merchants, Math.round(count * PENDING_SHARE), now,
  );

  const gateway = new SimulatedGateway({ seed, model: options.model, medianPaise: median });
  const learned: Outcome[] = [];

  const result: LiveBatchResult = {
    merchant_id: merchantId,
    mandates: mandates.length,
    amount_at_risk_paise: mandates.reduce((s, m) => s + m.amount_paise, 0),
    amount_recovered_paise: 0,
    attempts_spent: 0,
    mandates_recovered: 0,
    intents_written: 0,
    duplicates_blocked: 0,
    policy_refusals: {},
    orders_created: 0,
    decisions_recorded: 0,
    pending_cohort: pendingCohort,
    escalations: 0,
    merchants: merchants.length,
    control_mandates: 0,
    control_attempts: 0,
    control_recovered_paise: 0,
    control_mandates_recovered: 0,
    treatment_mandates: 0,
    treatment_attempts: 0,
    exactly_once_held: true,
  };

  for (const m of mandates) {
    const subscriptionId = `${merchantId}:${m.id}`;
    const arm = await assignArm(subscriptionId, `${merchantId}|${seed}`);

    if (arm === 'control') {
      result.control_mandates += 1;
      const outcome = await runControlArm(m, subscriptionId, gateway, now);
      result.control_attempts += outcome.attempts;
      if (outcome.recovered) {
        result.control_recovered_paise += m.amount_paise;
        result.control_mandates_recovered += 1;
      }
      continue;
    }

    result.treatment_mandates += 1;
    const classified = bucketFor(mandates.indexOf(m));
    let recovered = false;
    let attemptsUsed = 1;
    let cursor = m.first_failure_at > now ? m.first_failure_at : now;

    while (!recovered && attemptsUsed < NPCI_ATTEMPT_BUDGET) {
      const model = new SuccessModel(learned);
      const plan = buildPlan(
        {
          subscription_id: subscriptionId,
          bucket: classified.bucket,
          issuer: m.issuer,
          method: 'upi_autopay',
          amount_paise: m.amount_paise,
          attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
          days_to_halt: Math.max(0, Math.floor((m.cycle_end.getTime() - cursor.getTime()) / 86_400_000)),
          last_failure_at: m.first_failure_at,
          reauth_available: classified.bucket === 'HARD_INSTRUMENT',
          remaining_cycles: 6,
          now: cursor,
        },
        model,
      );

      const proposal: Proposal = classified.bucket === 'HARD_INSTRUMENT'
        ? {
            subscription_id: subscriptionId,
            action: 'REAUTH_OUTREACH',
            reason: 'The instrument is dead, so no retry can succeed. Ask for a new mandate.',
            confidence: 1,
          }
        : planToProposal(plan, subscriptionId);
      const ctx = await liveContext(subscriptionId, m, attemptsUsed, cursor, classified.bucket);
      const verdict = evaluate(proposal, ctx);

      if (verdict.verdict === 'DENY') {
        result.policy_refusals[verdict.rule_id] = (result.policy_refusals[verdict.rule_id] ?? 0) + 1;
        await recordDecision(subscriptionId, m.cycle_start, proposal, verdict, {
          bucket: 'SOFT_LIQUIDITY',
          issuer: m.issuer,
          method: 'upi_autopay',
          amount_paise: m.amount_paise,
          attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
          cycle_start: m.cycle_start.toISOString(),
          cycle_end: m.cycle_end.toISOString(),
          now: cursor.toISOString(),
          arm: 'treatment',
          source: 'batch',
        });
        result.decisions_recorded += 1;
        break;
      }
      if (proposal.action === 'HOLD') {
        cursor = new Date(cursor.getTime() + 86_400_000);
        if (cursor >= m.cycle_end) break;
        continue;
      }

      if (proposal.action === 'REAUTH_OUTREACH') {
        await recordDecision(subscriptionId, m.cycle_start, proposal, verdict, {
          bucket: classified.bucket,
          issuer: m.issuer,
          method: 'upi_autopay',
          amount_paise: m.amount_paise,
          attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
          cycle_start: m.cycle_start.toISOString(),
          cycle_end: m.cycle_end.toISOString(),
          now: cursor.toISOString(),
          arm: 'treatment',
          source: 'batch',
        });
        result.decisions_recorded += 1;
        result.escalations += 1;
        break;
      }

      const target = verdict.scheduled_for ?? proposal.scheduled_for;
      if (proposal.action !== 'RETRY_SCHEDULED' || !target) break;

      const at = new Date(target);
      if (at >= m.cycle_end) break;

      const decisionId = await recordDecision(subscriptionId, m.cycle_start, proposal, verdict, {
        bucket: 'SOFT_LIQUIDITY',
        issuer: m.issuer,
        method: 'upi_autopay',
        amount_paise: m.amount_paise,
        attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
        expected_paise: plan.expected_paise,
        slots_considered: plan.schedule.length,
        cycle_start: m.cycle_start.toISOString(),
        cycle_end: m.cycle_end.toISOString(),
        now: cursor.toISOString(),
        arm: 'treatment',
        source: 'batch',
      });
      result.decisions_recorded += 1;

      const outcome = await execute(
        {
          decision_id: decisionId,
          subscription_id: subscriptionId,
          rzp_subscription_id: m.id,
          cycle: m.cycle_start,
          attempt_number: attemptsUsed + 1,
          amount_paise: m.amount_paise,
          scheduled_for: at,
        },
        { gateway, dryRun: false },
      );

      if (outcome.status === 'duplicate') {
        result.duplicates_blocked += 1;
        break;
      }
      if (outcome.status === 'blocked') break;

      result.intents_written += 1;
      result.attempts_spent += 1;
      result.treatment_attempts += 1;
      attemptsUsed += 1;
      cursor = at;

      if (outcome.status === 'executed' && outcome.payment?.status === 'captured') {
        recovered = true;
        result.amount_recovered_paise += m.amount_paise;
        result.mandates_recovered += 1;
      }

      const charge = gateway.charges[gateway.charges.length - 1];
      learned.push({
        bucket: 'SOFT_LIQUIDITY',
        issuer: m.issuer,
        method: 'upi_autopay',
        day_of_month: at.getUTCDate(),
        hour: at.getUTCHours(),
        days_since_failure: (at.getTime() - m.first_failure_at.getTime()) / 86_400_000,
        amount_paise: m.amount_paise,
        succeeded: charge?.succeeded ?? false,
      });
    }
  }

  result.orders_created = gateway.attemptsMade;

  const { rows } = await query<{ keys: number; intents: number }>(
    `SELECT count(DISTINCT idempotency_key)::int AS keys, count(*)::int AS intents
       FROM execution_intent WHERE subscription_id LIKE $1`,
    [`${merchantId}:%`],
  );
  const chargesAcrossBothArms = result.treatment_attempts + result.control_attempts;
  result.exactly_once_held =
    rows[0]!.keys === rows[0]!.intents && gateway.attemptsMade === chargesAcrossBothArms;

  if (!result.exactly_once_held) {
    log.error('live_batch.exactly_once_violated', {
      distinct_keys: rows[0]!.keys,
      intents: rows[0]!.intents,
      orders: gateway.attemptsMade,
      attempts: result.attempts_spent,
    });
  }

  return result;
}

async function liveContext(
  subscriptionId: string,
  m: Mandate,
  attemptsUsed: number,
  now: Date,
  bucket: 'SOFT_LIQUIDITY' | 'HARD_INSTRUMENT' | 'HARD_CUSTOMER' = 'SOFT_LIQUIDITY',
): Promise<PolicyContext> {
  const { rows } = await query<{ attempts_used: number; paid: boolean }>(
    `SELECT
       (SELECT count(*)::int FROM payment_attempt
         WHERE subscription_id = $1 AND cycle = $2 AND counts_against_budget) AS attempts_used,
       EXISTS (SELECT 1 FROM payment_attempt
                WHERE subscription_id = $1 AND cycle = $2 AND status = 'captured') AS paid`,
    [subscriptionId, m.cycle_start],
  );

  return {
    now,
    kill_switch: false,
    write_enabled: true,
    subscription_status: 'pending',
    method: 'upi_autopay',
    integration: 'recurring_tokens',
    amount_paise: m.amount_paise,
    cycle: m.cycle_start,
    mandate_expiry_at: null,
    cycle_already_paid: rows[0]?.paid ?? false,
    attempts_remaining: Math.max(0, NPCI_ATTEMPT_BUDGET - attemptsUsed),
    attempt_number: attemptsUsed + 1,
    last_bucket: bucket,
    consecutive_soft_cycles: 0,
    max_soft_cycles: 3,
    attempt_exists: false,
    attempt_in_flight: false,
    issuer_degraded: false,
    contacts_this_cycle: 0,
    max_contacts_per_cycle: 1,
    blast_attempts_used: 0,
    blast_attempts_max: Number.MAX_SAFE_INTEGER,
  };
}
