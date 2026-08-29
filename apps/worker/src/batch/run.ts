import {
  NPCI_ATTEMPT_BUDGET,
  SuccessModel,
  addMs,
  evaluate,
  fromIst,
  toIstParts,
} from '@mandate/core';
import type { Outcome, PolicyContext, Proposal } from '@mandate/core';
import { buildPlan, planToProposal } from '../planner.ts';
import { successProbability } from './simulator.ts';
import type { GenerativeModel } from './simulator.ts';
import { mulberry32 } from './simulator.ts';

export type Arm = 'control' | 'treatment';

export interface Mandate {
  id: string;
  amount_paise: number;
  issuer: string;
  first_failure_at: Date;
  cycle_start: Date;
  cycle_end: Date;
}

export interface ArmResult {
  arm: Arm;
  mandates: number;
  amount_at_risk_paise: number;
  amount_recovered_paise: number;
  attempts_spent: number;
  mandates_recovered: number;
  mandates_halted: number;
  attempts_on_hard_declines: number;
  denials_by_rule: Record<string, number>;
}

export interface BatchResult {
  seed: number;
  mode: 'simulated' | 'live';
  generative_model: GenerativeModel | null;
  median_paise: number;
  control: ArmResult;
  treatment: ArmResult;
}

const CONTROL_OFFSET_DAYS = [1, 2, 3];

function emptyArm(arm: Arm): ArmResult {
  return {
    arm,
    mandates: 0,
    amount_at_risk_paise: 0,
    amount_recovered_paise: 0,
    attempts_spent: 0,
    mandates_recovered: 0,
    mandates_halted: 0,
    attempts_on_hard_declines: 0,
    denials_by_rule: {},
  };
}

export function generateMandates(count: number, seed: number, now: Date): Mandate[] {
  const rand = mulberry32(seed);
  const issuers = ['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK'];
  const mandates: Mandate[] = [];

  for (let i = 0; i < count; i += 1) {
    const ist = toIstParts(now);
    const cycleStart = fromIst(ist.year, ist.month, 1, 0);
    const cycleEnd = fromIst(ist.year, ist.month + 1, 1, 0);

    const paydayDay = 1 + Math.floor(rand() * 3);
    const hour = Math.floor(rand() * 6);
    const firstFailure = fromIst(ist.year, ist.month, paydayDay, hour * 60 + Math.floor(rand() * 60));

    const tier = rand();
    const amount = tier < 0.5 ? 19900 + Math.floor(rand() * 20000)
      : tier < 0.85 ? 49900 + Math.floor(rand() * 100000)
      : 200000 + Math.floor(rand() * 300000);

    mandates.push({
      id: `batch_sub_${i + 1}`,
      amount_paise: amount,
      issuer: issuers[Math.floor(rand() * issuers.length)]!,
      first_failure_at: firstFailure,
      cycle_start: cycleStart,
      cycle_end: cycleEnd,
    });
  }

  return mandates;
}

function policyContext(m: Mandate, attemptsUsed: number, now: Date): PolicyContext {
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
    cycle_already_paid: false,
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

function controlSchedule(m: Mandate): Date[] {
  return CONTROL_OFFSET_DAYS.map((d) => addMs(m.first_failure_at, d * 86_400_000));
}

export interface RunOptions {
  count?: number;
  seed?: number;
  model?: GenerativeModel;
  now?: Date;
}

export function runBatch(options: RunOptions = {}): BatchResult {
  const count = options.count ?? 120;
  const seed = options.seed ?? 20260902;
  const now = options.now ?? new Date();

  const mandates = generateMandates(count, seed, now);
  const amounts = mandates.map((m) => m.amount_paise).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)] ?? 0;

  const control = emptyArm('control');
  const treatment = emptyArm('treatment');

  const learned: Outcome[] = [];

  for (const m of mandates) {
  for (const armName of ['control', 'treatment'] as const) {
    const arm = armName === 'control' ? control : treatment;
    arm.mandates += 1;
    arm.amount_at_risk_paise += m.amount_paise;

    let recovered = false;
    let attemptsUsed = 1;

    const attemptAt = (at: Date): boolean => {
      const p = successProbability(at, m.amount_paise, median, options.model);
      const rand = mulberry32(seed + at.getTime() + m.amount_paise);
      const succeeded = rand() < p;
      const ist = toIstParts(at);

      learned.push({
        bucket: 'SOFT_LIQUIDITY',
        issuer: m.issuer,
        method: 'upi_autopay',
        day_of_month: ist.day,
        hour: ist.hour,
        days_since_failure: (at.getTime() - m.first_failure_at.getTime()) / 86_400_000,
        amount_paise: m.amount_paise,
        succeeded,
      });

      arm.attempts_spent += 1;
      attemptsUsed += 1;
      if (succeeded) {
        arm.amount_recovered_paise += m.amount_paise;
        arm.mandates_recovered += 1;
      }
      return succeeded;
    };

    if (armName === 'control') {
      for (const at of controlSchedule(m)) {
        if (recovered || attemptsUsed >= NPCI_ATTEMPT_BUDGET) break;
        recovered = attemptAt(at);
      }
    } else {
      const model = new SuccessModel(learned);
      let cursor = m.first_failure_at;

      while (!recovered && attemptsUsed < NPCI_ATTEMPT_BUDGET) {
        const plan = buildPlan(
          {
            subscription_id: m.id,
            bucket: 'SOFT_LIQUIDITY',
            issuer: m.issuer,
            method: 'upi_autopay',
            amount_paise: m.amount_paise,
            attempts_remaining: NPCI_ATTEMPT_BUDGET - attemptsUsed,
            days_to_halt: Math.floor((m.cycle_end.getTime() - cursor.getTime()) / 86_400_000),
            last_failure_at: m.first_failure_at,
            reauth_available: false,
            remaining_cycles: 6,
            now: cursor,
          },
          model,
        );

        const proposal: Proposal = planToProposal(plan, m.id);
        const verdict = evaluate(proposal, policyContext(m, attemptsUsed, cursor));

        if (verdict.verdict === 'DENY') {
          arm.denials_by_rule[verdict.rule_id] = (arm.denials_by_rule[verdict.rule_id] ?? 0) + 1;
          break;
        }
        if (proposal.action === 'HOLD') {
          const next = addMs(cursor, 86_400_000);
          if (next >= m.cycle_end) break;
          cursor = next;
          continue;
        }

        const target = verdict.scheduled_for ?? proposal.scheduled_for;
        if (proposal.action !== 'RETRY_SCHEDULED' || !target) break;

        const at = new Date(target);
        if (at >= m.cycle_end) break;

        recovered = attemptAt(at);
        cursor = at;
      }
    }

    if (!recovered) arm.mandates_halted += 1;
  }
  }

  return {
    seed,
    mode: 'simulated',
    generative_model: options.model ?? null,
    median_paise: median,
    control,
    treatment,
  };
}
