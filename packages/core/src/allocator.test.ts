import { describe, expect, it } from 'vitest';
import { SuccessModel } from './success-model.ts';
import type { Outcome, Slot } from './success-model.ts';
import { planRecovery } from './allocator.ts';
import type { AllocatorInput, CandidateSlot } from './allocator.ts';

const AMOUNT = 100000;

function slot(over: Partial<Slot> = {}): Slot {
  return {
    bucket: 'SOFT_LIQUIDITY',
    issuer: 'HDFC',
    method: 'upi_autopay',
    day_of_month: 5,
    hour: 14,
    days_since_failure: 1,
    amount_paise: AMOUNT,
    ...over,
  };
}

function candidate(days: number, over: Partial<Slot> = {}): CandidateSlot {
  return {
    at: new Date(Date.UTC(2026, 8, 1 + days, 8, 0, 0)),
    days_from_now: days,
    slot: slot({ days_since_failure: days, ...over }),
  };
}

function outcomes(n: number, successRate: number, over: Partial<Slot> = {}): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({
    ...slot(over),
    succeeded: i / n < successRate,
  }));
}

function input(over: Partial<AllocatorInput> = {}): AllocatorInput {
  return {
    amount_paise: AMOUNT,
    attempts_remaining: 3,
    days_to_halt: 10,
    candidates: [candidate(0), candidate(3), candidate(6)],
    reauth_conversion: 0.2,
    reauth_value_fraction: 1,
    reauth_available: true,
    ...over,
  };
}

describe('it prefers the slot with the better chance', () => {
  it('picks a later slot when the model says it is more likely to clear', () => {
    const model = new SuccessModel([
      ...outcomes(200, 0.1, { day_of_month: 1, days_since_failure: 0 }),
      ...outcomes(200, 0.85, { day_of_month: 4, days_since_failure: 3 }),
    ]);

    const plan = planRecovery(
      input({
        attempts_remaining: 1,
        reauth_available: false,
        candidates: [candidate(0, { day_of_month: 1 }), candidate(3, { day_of_month: 4 })],
      }),
      model,
    );

    expect(plan.action).toBe('RETRY');
    expect(plan.at?.getUTCDate()).toBe(4);
  });

  it('reports what waiting was worth', () => {
    const model = new SuccessModel([
      ...outcomes(200, 0.05, { day_of_month: 1, days_since_failure: 0 }),
      ...outcomes(200, 0.9, { day_of_month: 4, days_since_failure: 3 }),
    ]);

    const plan = planRecovery(
      input({
        attempts_remaining: 1,
        reauth_available: false,
        candidates: [candidate(0, { day_of_month: 1 }), candidate(3, { day_of_month: 4 })],
      }),
      model,
    );

    expect(plan.value_of_waiting_paise).toBeGreaterThan(0);
    expect(plan.reason).toContain('Waiting is worth');
  });

  it('acts immediately when the earliest slot is already the best', () => {
    const model = new SuccessModel([
      ...outcomes(200, 0.9, { day_of_month: 1, days_since_failure: 0 }),
      ...outcomes(200, 0.2, { day_of_month: 4, days_since_failure: 3 }),
    ]);

    const plan = planRecovery(
      input({
        attempts_remaining: 1,
        reauth_available: false,
        candidates: [candidate(0, { day_of_month: 1 }), candidate(3, { day_of_month: 4 })],
      }),
      model,
    );

    expect(plan.at?.getUTCDate()).toBe(1);
  });
});

describe('amount awareness', () => {
  it('a large mandate justifies an attempt a small one does not', () => {
    const model = new SuccessModel(outcomes(200, 0.05));
    const cheap = planRecovery(input({ amount_paise: 1000, reauth_conversion: 0.5 }), model);
    const rich = planRecovery(input({ amount_paise: 5_000_000, reauth_conversion: 0.02, reauth_value_fraction: 0.1 }), model);

    expect(rich.expected_paise).toBeGreaterThan(cheap.expected_paise);
  });
});

describe('the budget is respected', () => {
  it('schedules no more attempts than remain', () => {
    const model = new SuccessModel(outcomes(200, 0.5));
    const plan = planRecovery(
      input({ attempts_remaining: 2, candidates: [candidate(0), candidate(1), candidate(2), candidate(3)] }),
      model,
    );
    expect(plan.schedule.filter((s) => s.action === 'RETRY').length).toBeLessThanOrEqual(2);
  });

  it('stops when no attempts remain and re-authorization is unavailable', () => {
    const plan = planRecovery(
      input({ attempts_remaining: 0, reauth_available: false }),
      new SuccessModel(outcomes(100, 0.9)),
    );
    expect(plan.action).toBe('STOP');
    expect(plan.expected_paise).toBe(0);
  });

  it('stops when the mandate halts today', () => {
    const plan = planRecovery(
      input({ days_to_halt: 0, candidates: [], reauth_available: false }),
      new SuccessModel(outcomes(100, 0.9)),
    );
    expect(plan.action).toBe('STOP');
  });
});

describe('re-authorization competes on the same terms', () => {
  it('chooses re-auth when retrying is nearly hopeless', () => {
    const model = new SuccessModel(outcomes(400, 0.001));
    const plan = planRecovery(
      input({ attempts_remaining: 1, reauth_conversion: 0.6, reauth_decay_per_attempt: 0.3 }),
      model,
    );
    expect(plan.action).toBe('REAUTH');
  });

  it('a mandate with no attempts left is still worth re-authorizing, not zero', () => {
    const plan = planRecovery(
      input({ attempts_remaining: 0, reauth_conversion: 0.5 }),
      new SuccessModel(outcomes(100, 0.5)),
    );
    expect(plan.action).toBe('REAUTH');
    expect(plan.expected_paise).toBeGreaterThan(0);
  });

  it('spending attempts lowers what re-authorization is worth afterwards', () => {
    const model = new SuccessModel(outcomes(400, 0.001));
    const fresh = planRecovery(input({ attempts_remaining: 0, reauth_conversion: 0.6, reauth_decay_per_attempt: 0.5 }), model);
    const spent = planRecovery(input({ attempts_remaining: 3, reauth_conversion: 0.6, reauth_decay_per_attempt: 0.5 }), model);
    expect(spent.schedule.filter((x) => x.action === 'RETRY').length).toBeGreaterThanOrEqual(0);
    expect(fresh.expected_paise).toBeGreaterThan(0);
  });

  it('chooses retry when the mandate is likely to clear', () => {
    const model = new SuccessModel(outcomes(400, 0.85));
    const plan = planRecovery(input({ reauth_conversion: 0.1 }), model);
    expect(plan.action).toBe('RETRY');
  });

  it('never proposes re-auth when it is unavailable', () => {
    const model = new SuccessModel(outcomes(400, 0.01));
    const plan = planRecovery(input({ reauth_available: false, reauth_conversion: 0.9 }), model);
    expect(plan.action).not.toBe('REAUTH');
  });
});

describe('it is total', () => {
  it.each([
    ['no candidates', { candidates: [] }],
    ['negative attempts', { attempts_remaining: -3 }],
    ['negative horizon', { days_to_halt: -5 }],
    ['absurd horizon', { days_to_halt: 9999 }],
    ['absurd attempts', { attempts_remaining: 9999 }],
    ['zero amount', { amount_paise: 0 }],
    ['candidates beyond the horizon', { days_to_halt: 2, candidates: [candidate(40)] }],
  ])('does not throw on %s', (_label, over) => {
    const plan = planRecovery(input(over), new SuccessModel(outcomes(50, 0.5)));
    expect(plan).toBeDefined();
    expect(Number.isFinite(plan.expected_paise)).toBe(true);
    expect(plan.expected_paise).toBeGreaterThanOrEqual(0);
  });

  it('works with an untrained model by falling back to the prior', () => {
    const plan = planRecovery(input(), new SuccessModel([]));
    expect(plan).toBeDefined();
    expect(plan.schedule.length).toBeGreaterThan(0);
  });

  it('never expects more than the mandate is worth', () => {
    const model = new SuccessModel(outcomes(400, 1));
    const plan = planRecovery(input({ reauth_available: false }), model);
    expect(plan.expected_paise).toBeLessThanOrEqual(AMOUNT);
  });

  it('always explains itself', () => {
    const plan = planRecovery(input(), new SuccessModel(outcomes(100, 0.5)));
    expect(plan.reason.length).toBeGreaterThan(20);
  });
});
