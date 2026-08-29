import { NPCI_ATTEMPT_BUDGET, SuccessModel, evaluate } from '@mandate/core';
import type { Outcome, PolicyContext, Proposal } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { execute } from '../executor.ts';
import { buildPlan, planToProposal } from '../planner.ts';
import { log } from '../log.ts';
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
  exactly_once_held: boolean;
}

export interface LiveBatchOptions {
  count?: number;
  seed?: number;
  model?: GenerativeModel;
  now?: Date;
  merchantId?: string;
}

async function seedMandates(merchantId: string, mandates: Mandate[]): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO merchant (id, name, mode, write_enabled, integration)
       VALUES ($1,$1,'test',TRUE,'recurring_tokens')
       ON CONFLICT (id) DO UPDATE SET write_enabled = TRUE`,
      [merchantId],
    );

    for (const m of mandates) {
      const id = `${merchantId}:${m.id}`;
      await client.query(
        `INSERT INTO subscription (
           id, merchant_id, rzp_subscription_id, customer_ref, method, amount_paise,
           status, current_start, current_end, rzp_token_id, rzp_customer_id
         ) VALUES ($1,$2,$3,$3,'upi_autopay',$4,'pending',$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [id, merchantId, m.id, m.amount_paise, m.cycle_start, m.cycle_end,
         `token_${m.id}`, `cust_${m.id}`],
      );

      await client.query(
        `INSERT INTO payment_attempt (
           subscription_id, cycle, attempted_at, status, amount_paise,
           error_reason, error_source, bucket, issuer, initiated_by
         ) VALUES ($1,$2,$3,'failed',$4,'insufficient_funds','customer','SOFT_LIQUIDITY',$5,'razorpay_default')`,
        [id, m.cycle_start, m.first_failure_at, m.amount_paise, m.issuer],
      );
    }
  });
}

export async function cleanup(merchantId: string): Promise<void> {
  await query(`DELETE FROM execution_intent WHERE subscription_id LIKE $1`, [`${merchantId}:%`]);
  await query(`DELETE FROM decision WHERE subscription_id LIKE $1`, [`${merchantId}:%`]);
  await query(`DELETE FROM mandate_health WHERE subscription_id LIKE $1`, [`${merchantId}:%`]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id LIKE $1`, [`${merchantId}:%`]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [merchantId]);
  await query(`DELETE FROM merchant WHERE id = $1`, [merchantId]);
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

  await cleanup(merchantId);
  await seedMandates(merchantId, mandates);

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
    exactly_once_held: true,
  };

  for (const m of mandates) {
    const subscriptionId = `${merchantId}:${m.id}`;
    let recovered = false;
    let attemptsUsed = 1;
    let cursor = m.first_failure_at > now ? m.first_failure_at : now;

    while (!recovered && attemptsUsed < NPCI_ATTEMPT_BUDGET) {
      const model = new SuccessModel(learned);
      const plan = buildPlan(
        {
          subscription_id: subscriptionId,
          bucket: 'SOFT_LIQUIDITY',
          issuer: m.issuer,
          method: 'upi_autopay',
          amount_paise: m.amount_paise,
          attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
          days_to_halt: Math.max(0, Math.floor((m.cycle_end.getTime() - cursor.getTime()) / 86_400_000)),
          last_failure_at: m.first_failure_at,
          reauth_available: false,
          remaining_cycles: 6,
          now: cursor,
        },
        model,
      );

      const proposal: Proposal = planToProposal(plan, subscriptionId);
      const ctx = await liveContext(subscriptionId, m, attemptsUsed, cursor);
      const verdict = evaluate(proposal, ctx);

      if (verdict.verdict === 'DENY') {
        result.policy_refusals[verdict.rule_id] = (result.policy_refusals[verdict.rule_id] ?? 0) + 1;
        break;
      }
      if (proposal.action === 'HOLD') {
        cursor = new Date(cursor.getTime() + 86_400_000);
        if (cursor >= m.cycle_end) break;
        continue;
      }

      const target = verdict.scheduled_for ?? proposal.scheduled_for;
      if (proposal.action !== 'RETRY_SCHEDULED' || !target) break;

      const at = new Date(target);
      if (at >= m.cycle_end) break;

      const outcome = await execute(
        {
          decision_id: null,
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
  result.exactly_once_held =
    rows[0]!.keys === rows[0]!.intents && gateway.attemptsMade === result.attempts_spent;

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
    last_bucket: 'SOFT_LIQUIDITY',
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
