import { describe, expect, it } from 'vitest';
import { NPCI_ATTEMPT_BUDGET, score } from './health.ts';
import type { HealthInput } from './health.ts';

const NOW = new Date('2026-09-01T08:00:00Z');

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    consecutive_failures: 0,
    attempts_used_this_cycle: 0,
    mandate_expiry_at: new Date('2027-09-01T00:00:00Z'),
    soft_decline_rate: 0,
    issuer_degraded: false,
    method: 'upi_autopay',
    last_bucket: null,
    ...over,
  };
}

describe('bands', () => {
  it('a clean subscription is healthy', () => {
    expect(score(input()).risk_band).toBe('healthy');
  });

  it('one failure moves it to at_risk', () => {
    expect(score(input({ consecutive_failures: 1 })).risk_band).toBe('at_risk');
  });

  it('a hard decline is critical regardless of attempts left', () => {
    const s = score(input({ last_bucket: 'HARD_INSTRUMENT', attempts_used_this_cycle: 0 }));
    expect(s.risk_band).toBe('critical');
  });

  it('one attempt left is critical', () => {
    expect(score(input({ attempts_used_this_cycle: 3 })).risk_band).toBe('critical');
  });

  it('expiry inside seven days is critical even with no failures', () => {
    const s = score(input({ mandate_expiry_at: new Date('2026-09-05T00:00:00Z') }));
    expect(s.risk_band).toBe('critical');
  });

  it('flags at_risk before any failure when the issuer is degraded', () => {
    expect(score(input({ issuer_degraded: true })).risk_band).toBe('at_risk');
  });

  it('flags at_risk before any failure on a chronic soft-decline history', () => {
    expect(score(input({ soft_decline_rate: 0.6 })).risk_band).toBe('at_risk');
  });
});

describe('attempts remaining tracks the NPCI budget', () => {
  it.each([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0], [9, 0]])(
    '%i used leaves %i',
    (used, remaining) => {
      expect(score(input({ attempts_used_this_cycle: used })).attempts_remaining).toBe(remaining);
    },
  );

  it('never reports more than the budget', () => {
    expect(score(input({ attempts_used_this_cycle: -5 })).attempts_remaining).toBe(NPCI_ATTEMPT_BUDGET);
  });
});

describe('score', () => {
  it('rises monotonically with consecutive failures', () => {
    const scores = [0, 1, 2, 3].map((n) => score(input({ consecutive_failures: n })).risk_score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  it('stays within 0 and 1 even when every signal is maxed', () => {
    const s = score(input({
      consecutive_failures: 9,
      attempts_used_this_cycle: 4,
      mandate_expiry_at: new Date('2026-08-01T00:00:00Z'),
      soft_decline_rate: 1,
      issuer_degraded: true,
      last_bucket: 'HARD_CUSTOMER',
    }));
    expect(s.risk_score).toBeLessThanOrEqual(1);
    expect(s.risk_score).toBeGreaterThan(0.9);
  });

  it('exposes contributions so a dashboard can explain the number', () => {
    const s = score(input({ consecutive_failures: 2, issuer_degraded: true }));
    expect(s.contributions['consecutive_failures']).toBeGreaterThan(0);
    expect(s.contributions['issuer_degraded']).toBe(0.08);
    expect(Object.keys(s.contributions).length).toBeGreaterThan(3);
  });

  it('reports a null expiry rather than inventing one', () => {
    expect(score(input({ mandate_expiry_at: null })).days_to_expiry).toBeNull();
  });

  it('is total: no input throws and the score is always a finite number', () => {
    const shapes: Partial<HealthInput>[] = [
      { consecutive_failures: Number.NaN },
      { attempts_used_this_cycle: Number.NaN },
      { soft_decline_rate: Number.NaN },
      { soft_decline_rate: 99 },
      { soft_decline_rate: -1 },
      { mandate_expiry_at: new Date('invalid') },
    ];
    for (const shape of shapes) {
      const s = score(input(shape));
      expect(Number.isFinite(s.risk_score)).toBe(true);
      expect(s.days_to_expiry === null || Number.isFinite(s.days_to_expiry)).toBe(true);
      expect(s.risk_score).toBeGreaterThanOrEqual(0);
      expect(s.risk_score).toBeLessThanOrEqual(1);
    }
  });
});
