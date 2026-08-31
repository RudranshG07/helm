import { fromIst, toIstParts } from './time.ts';

export const PROMISE_MAX_HORIZON_DAYS = 21;
export const PROMISE_ATTEMPT_HOUR_IST = 11 * 60;

export type PromiseStatus = 'open' | 'kept' | 'broken' | 'superseded' | 'expired';

export interface PromiseInput {
  promised_for: string;
  now: Date;
  cycle_end: Date | null;
}

export type PromiseCheck =
  | { ok: true; promised_for: string; attempt_at: Date }
  | { ok: false; error: string };

function parseDay(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function promiseAttemptTime(promisedFor: string): Date | null {
  const parsed = parseDay(promisedFor);
  if (!parsed) return null;
  return fromIst(parsed.year, parsed.month, parsed.day, PROMISE_ATTEMPT_HOUR_IST);
}

export function checkPromise(input: PromiseInput): PromiseCheck {
  const parsed = parseDay(input.promised_for);
  if (!parsed) return { ok: false, error: 'Pick a date in YYYY-MM-DD form.' };

  const attemptAt = fromIst(parsed.year, parsed.month, parsed.day, PROMISE_ATTEMPT_HOUR_IST);
  const today = toIstParts(input.now);
  const todayStart = fromIst(today.year, today.month, today.day, 0);
  const promisedStart = fromIst(parsed.year, parsed.month, parsed.day, 0);

  if (promisedStart.getTime() < todayStart.getTime()) {
    return { ok: false, error: 'That date has already passed.' };
  }

  const horizon = todayStart.getTime() + PROMISE_MAX_HORIZON_DAYS * 86_400_000;
  if (promisedStart.getTime() > horizon) {
    return { ok: false, error: `Pick a date within ${PROMISE_MAX_HORIZON_DAYS} days.` };
  }

  if (input.cycle_end && attemptAt.getTime() > input.cycle_end.getTime()) {
    return { ok: false, error: 'That date is after this mandate would be cancelled.' };
  }

  return { ok: true, promised_for: input.promised_for.trim(), attempt_at: attemptAt };
}

export interface PromiseRecord {
  promised_for: string;
  status: PromiseStatus;
}

export function promiseReliability(history: PromiseRecord[]): {
  kept: number;
  broken: number;
  rate: number;
  confident: boolean;
} {
  const kept = history.filter((p) => p.status === 'kept').length;
  const broken = history.filter((p) => p.status === 'broken').length;
  const settled = kept + broken;
  return {
    kept,
    broken,
    rate: settled === 0 ? 0 : kept / settled,
    confident: settled >= 3,
  };
}
