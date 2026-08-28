import { describe, expect, it } from 'vitest';
import { PDN_MIN_LEAD_MS, SuccessModel, isPeak, toIstParts } from '@mandate/core';
import type { Plan } from '@mandate/core';
import { buildPlan, candidateSlots, planToProposal } from './planner.ts';
import type { PlanRequest } from './planner.ts';

const NOW = new Date('2026-09-01T02:30:00.000Z');

function req(over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    subscription_id: 'm:sub_1',
    bucket: 'SOFT_LIQUIDITY',
    issuer: 'HDFC',
    method: 'upi_autopay',
    amount_paise: 149900,
    attempts_remaining: 3,
    days_to_halt: 14,
    last_failure_at: new Date(NOW.getTime() - 6 * 3600 * 1000),
    reauth_available: true,
    remaining_cycles: 6,
    now: NOW,
    ...over,
  };
}

describe('candidate slots obey every timing bound', () => {
  it('never offers a slot inside the pre-debit notification floor', () => {
    const floor = NOW.getTime() + PDN_MIN_LEAD_MS;
    for (const c of candidateSlots(req())) {
      expect(c.at.getTime()).toBeGreaterThanOrEqual(floor);
    }
  });

  it('never offers a slot inside a peak execution window', () => {
    for (const c of candidateSlots(req())) {
      expect(isPeak(c.at)).toBe(false);
    }
  });

  it('never offers a slot beyond the horizon', () => {
    const slots = candidateSlots(req({ days_to_halt: 3 }));
    for (const c of slots) {
      expect(c.days_from_now).toBeLessThanOrEqual(3);
    }
  });

  it('produces nothing when the mandate halts before the notification floor clears', () => {
    expect(candidateSlots(req({ days_to_halt: 0 }))).toHaveLength(0);
  });

  it('carries the IST day and hour onto the slot, not the UTC ones', () => {
    const c = candidateSlots(req())[0]!;
    const ist = toIstParts(c.at);
    expect(c.slot.day_of_month).toBe(ist.day);
    expect(c.slot.hour).toBe(ist.hour);
  });

  it('computes the lag from the failure, not from now', () => {
    const slots = candidateSlots(req({ last_failure_at: new Date(NOW.getTime() - 5 * 86_400_000) }));
    expect(slots[0]!.slot.days_since_failure).toBeGreaterThan(5);
  });
});

describe('plans map onto proposals the policy engine understands', () => {
  const base: Plan = {
    action: 'RETRY',
    at: new Date('2026-09-03T02:30:00.000Z'),
    expected_paise: 60000,
    value_of_waiting_paise: 0,
    best_immediate_paise: 60000,
    schedule: [{ action: 'RETRY', at: new Date(), days_from_now: 2, expected_paise: 60000, p_success: 0.42, evidence: 12, level: 'cell' }],
    reason: 'because',
  };

  it('a retry becomes RETRY_SCHEDULED with its slot', () => {
    const p = planToProposal(base, 'sub_1');
    expect(p.action).toBe('RETRY_SCHEDULED');
    expect(p.scheduled_for).toBe(base.at!.toISOString());
  });

  it('a re-auth becomes REAUTH_OUTREACH with no slot', () => {
    const p = planToProposal({ ...base, action: 'REAUTH', at: null }, 'sub_1');
    expect(p.action).toBe('REAUTH_OUTREACH');
    expect(p.scheduled_for).toBeUndefined();
  });

  it('a wait becomes HOLD', () => {
    expect(planToProposal({ ...base, action: 'WAIT', at: null }, 'sub_1').action).toBe('HOLD');
  });

  it('a stop becomes STOP', () => {
    expect(planToProposal({ ...base, action: 'STOP', at: null }, 'sub_1').action).toBe('STOP');
  });

  it('carries the model probability through as confidence, clamped', () => {
    expect(planToProposal(base, 'sub_1').confidence).toBe(0.42);
  });
});

describe('the plan is economically coherent', () => {
  it('never expects more than the mandate plus its remaining lifetime is worth', () => {
    const plan = buildPlan(req({ remaining_cycles: 6 }), new SuccessModel([]));
    expect(plan.expected_paise).toBeLessThanOrEqual(149900 * 7);
  });

  it('values a mandate with more cycles left above one near its end', () => {
    const model = new SuccessModel([]);
    const long = buildPlan(req({ remaining_cycles: 10 }), model);
    const short = buildPlan(req({ remaining_cycles: 0 }), model);
    expect(long.expected_paise).toBeGreaterThan(short.expected_paise);
  });

  it('proposes a slot that is itself legal', () => {
    const plan = buildPlan(req(), new SuccessModel([]));
    if (plan.at) {
      expect(plan.at.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + PDN_MIN_LEAD_MS);
      expect(isPeak(plan.at)).toBe(false);
    }
  });

  it('falls back to re-authorization when there is no legal slot left', () => {
    const plan = buildPlan(req({ days_to_halt: 0 }), new SuccessModel([]));
    expect(plan.action).not.toBe('RETRY');
  });

  it('does not throw on a mandate with no attempts left', () => {
    expect(() => buildPlan(req({ attempts_remaining: 0 }), new SuccessModel([]))).not.toThrow();
  });

  it('always produces a reason a merchant can read', () => {
    expect(buildPlan(req(), new SuccessModel([])).reason.length).toBeGreaterThan(20);
  });
});
