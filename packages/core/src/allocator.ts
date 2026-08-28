import type { Bucket, Method } from './types.ts';
import type { Prediction, Slot, SuccessModel } from './success-model.ts';

export type PlanAction = 'RETRY' | 'WAIT' | 'REAUTH' | 'STOP';

export interface CandidateSlot {
  at: Date;
  days_from_now: number;
  slot: Slot;
}

export interface AllocatorInput {
  amount_paise: number;
  mandate_lifetime_paise?: number;
  attempts_remaining: number;
  days_to_halt: number;
  candidates: CandidateSlot[];
  reauth_conversion: number;
  reauth_value_fraction: number;
  reauth_available: boolean;
  reauth_decay_per_attempt?: number;
}

export interface PlanStep {
  action: PlanAction;
  at: Date | null;
  days_from_now: number;
  expected_paise: number;
  p_success: number | null;
  evidence: number;
  level: Prediction['level'] | null;
}

export interface RankedSlot {
  at: Date;
  value_paise: number;
  p_success: number;
}

export interface Plan {
  action: PlanAction;
  at: Date | null;
  expected_paise: number;
  value_of_waiting_paise: number;
  best_immediate_paise: number;
  schedule: PlanStep[];
  ranked_slots: RankedSlot[];
  reason: string;
}

const MAX_DAYS = 45;

export function planRecovery(input: AllocatorInput, model: SuccessModel): Plan {
  const attempts = Math.max(0, Math.min(8, Math.floor(input.attempts_remaining)));
  const horizon = Math.max(0, Math.min(MAX_DAYS, Math.floor(input.days_to_halt)));

  const byDay = new Map<number, CandidateSlot[]>();
  for (const c of input.candidates) {
    const d = Math.floor(c.days_from_now);
    if (d < 0 || d > horizon) continue;
    const list = byDay.get(d) ?? [];
    list.push(c);
    byDay.set(d, list);
  }

  const predictions = new Map<CandidateSlot, Prediction>();
  for (const c of input.candidates) predictions.set(c, model.predict(c.slot));

  const decay = clampUnit(input.reauth_decay_per_attempt ?? 0.8);
  const lifetime = Math.max(0, input.mandate_lifetime_paise ?? 0);
  const successValue = input.amount_paise + lifetime;

  const reauthValueAt = (attemptsLeft: number): number => {
    if (!input.reauth_available) return 0;
    const spent = Math.max(0, attempts - attemptsLeft);
    return input.reauth_conversion * decay ** spent * successValue * input.reauth_value_fraction;
  };

  const V: number[][] = Array.from({ length: attempts + 1 }, () =>
    new Array<number>(horizon + 1).fill(0),
  );
  const best: (CandidateSlot | null)[][] = Array.from({ length: attempts + 1 }, () =>
    new Array<CandidateSlot | null>(horizon + 1).fill(null),
  );
  const bestAction: PlanAction[][] = Array.from({ length: attempts + 1 }, () =>
    new Array<PlanAction>(horizon + 1).fill('STOP'),
  );

  for (let d = 0; d <= horizon; d += 1) {
    V[0]![d] = d > 0 ? reauthValueAt(0) : 0;
    bestAction[0]![d] = d > 0 && V[0]![d]! > 0 ? 'REAUTH' : 'STOP';
  }

  for (let k = 1; k <= attempts; k += 1) {
    for (let d = 0; d <= horizon; d += 1) {
      let bestValue = 0;
      let action: PlanAction = 'STOP';
      let chosen: CandidateSlot | null = null;

      if (d > 0) {
        const waitValue = V[k]![d - 1]!;
        if (waitValue > bestValue) {
          bestValue = waitValue;
          action = 'WAIT';
        }
      }

      const reauthNow = d > 0 ? reauthValueAt(k) : 0;
      if (reauthNow > bestValue) {
        bestValue = reauthNow;
        action = 'REAUTH';
      }

      const daysAhead = horizon - d;
      for (const c of byDay.get(daysAhead) ?? []) {
        const p = predictions.get(c)!.p;
        const remainingAfter = Math.max(0, d - 1);
        const value = p * successValue + (1 - p) * V[k - 1]![remainingAfter]!;
        if (value > bestValue) {
          bestValue = value;
          action = 'RETRY';
          chosen = c;
        }
      }

      V[k]![d] = bestValue;
      bestAction[k]![d] = action;
      best[k]![d] = chosen;
    }
  }

  const schedule: PlanStep[] = [];
  let k = attempts;
  let d = horizon;
  let guard = 0;

  if (k === 0) {
    const terminal = V[0]?.[d] ?? 0;
    if (terminal > 0) {
      schedule.push({
        action: 'REAUTH', at: null, days_from_now: 0,
        expected_paise: Math.round(terminal), p_success: input.reauth_conversion,
        evidence: 0, level: null,
      });
    }
  }

  while (k > 0 && d >= 0 && guard < MAX_DAYS * 2) {
    guard += 1;
    const action = bestAction[k]![d]!;
    const chosen = best[k]![d];

    if (action === 'STOP') {
      schedule.push({ action: 'STOP', at: null, days_from_now: horizon - d, expected_paise: 0, p_success: null, evidence: 0, level: null });
      break;
    }
    if (action === 'REAUTH') {
      schedule.push({ action: 'REAUTH', at: null, days_from_now: horizon - d, expected_paise: Math.round(reauthValueAt(k)), p_success: input.reauth_conversion, evidence: 0, level: null });
      break;
    }
    if (action === 'WAIT') {
      if (d === 0) break;
      d -= 1;
      continue;
    }

    const pred = chosen ? predictions.get(chosen)! : null;
    schedule.push({
      action: 'RETRY',
      at: chosen?.at ?? null,
      days_from_now: horizon - d,
      expected_paise: Math.round(V[k]![d]!),
      p_success: pred?.p ?? null,
      evidence: pred?.evidence ?? 0,
      level: pred?.level ?? null,
    });
    k -= 1;
    d = Math.max(0, d - 1);
  }

  const ranked: RankedSlot[] = [];
  for (const [dayOffset, slots] of byDay) {
    const d = horizon - dayOffset;
    if (d < 0 || d > horizon) continue;
    for (const c of slots) {
      const p = predictions.get(c)!.p;
      const remainingAfter = Math.max(0, d - 1);
      const continuation = attempts > 0 ? V[Math.max(0, attempts - 1)]![remainingAfter]! : 0;
      ranked.push({
        at: c.at,
        value_paise: Math.round(p * successValue + (1 - p) * continuation),
        p_success: p,
      });
    }
  }
  ranked.sort((a, b) => b.value_paise - a.value_paise || a.at.getTime() - b.at.getTime());

  const earliestDay = [...byDay.keys()].sort((a, b) => a - b)[0];
  const immediateCandidates = earliestDay === undefined ? [] : byDay.get(earliestDay) ?? [];
  const bestImmediate = immediateCandidates.reduce((acc, c) => {
    const p = predictions.get(c)!.p;
    const remaining = Math.max(0, horizon - (earliestDay ?? 0) - 1);
    const v = p * successValue + (1 - p) * (attempts > 1 ? V[attempts - 1]![remaining]! : reauthValueAt(0));
    return Math.max(acc, v);
  }, 0);

  const top = V[attempts]?.[horizon] ?? 0;
  const first = schedule[0] ?? null;

  return {
    action: first?.action ?? 'STOP',
    at: first?.at ?? null,
    expected_paise: Math.round(top),
    best_immediate_paise: Math.round(bestImmediate),
    value_of_waiting_paise: Math.round(top - bestImmediate),
    schedule,
    ranked_slots: ranked,
    reason: explain(first, top, bestImmediate, input),
  };
}

function explain(
  first: PlanStep | null,
  total: number,
  immediate: number,
  input: AllocatorInput,
): string {
  const r = (paise: number) => `₹${(paise / 100).toFixed(0)}`;

  if (!first || first.action === 'STOP') {
    return 'No remaining action is worth more than stopping.';
  }
  if (first.action === 'REAUTH') {
    return 'A fresh authorization is worth more than any remaining attempt on this mandate.';
  }
  if (total - immediate > input.amount_paise * 0.02) {
    return `Waiting is worth ${r(total - immediate)} more than taking the earliest legal slot (${r(total)} against ${r(immediate)}).`;
  }
  const stake = input.amount_paise + Math.max(0, input.mandate_lifetime_paise ?? 0);
  return `Attempting at the chosen slot is worth ${r(total)} against ${r(stake)} at stake on this mandate.`;
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0.8;
  return Math.min(1, Math.max(0, n));
}
