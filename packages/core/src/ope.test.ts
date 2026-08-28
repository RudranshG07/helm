import { describe, expect, it } from 'vitest';
import { MIN_ESS, WEIGHT_CLIP, evaluateOffPolicy, exploreAmong } from './ope.ts';
import type { LoggedDecision } from './ope.ts';

function logged(n: number, over: Partial<LoggedDecision> = {}): LoggedDecision[] {
  return Array.from({ length: n }, () => ({
    action: 'RETRY_SCHEDULED',
    logging_propensity: 0.5,
    target_propensity: 0.5,
    reward_paise: 10000,
    ...over,
  }));
}

describe('it refuses to estimate from a deterministic logger', () => {
  it('says so plainly rather than returning a number', () => {
    const r = evaluateOffPolicy(logged(500, { logging_propensity: 1, target_propensity: 1 }));
    expect(r.support).toBe('deterministic_logger');
    expect(r.ips_paise).toBeNull();
    expect(r.snips_paise).toBeNull();
  });

  it('explains that randomising a fraction of decisions is what creates support', () => {
    const r = evaluateOffPolicy(logged(500, { logging_propensity: 1, target_propensity: 1 }));
    expect(r.explanation).toContain('Randomising');
  });

  it('returns no support when nothing usable was logged', () => {
    expect(evaluateOffPolicy([]).support).toBe('no_support');
    expect(evaluateOffPolicy(logged(10, { logging_propensity: 0 })).support).toBe('no_support');
  });
});

describe('it recovers a known value when the policies overlap', () => {
  it('reproduces the observed mean when target and logging policies match', () => {
    const r = evaluateOffPolicy(logged(400, { logging_propensity: 0.5, target_propensity: 0.5 }));
    expect(r.support).toBe('usable');
    expect(r.snips_paise).toBe(10000);
  });

  it('scales the estimate when the target policy favours the logged action', () => {
    const r = evaluateOffPolicy(logged(400, { logging_propensity: 0.25, target_propensity: 0.75 }));
    expect(r.ips_paise).toBeGreaterThan(r.observed_paise);
  });

  it('discounts the estimate when the target policy avoids the logged action', () => {
    const r = evaluateOffPolicy(logged(400, { logging_propensity: 0.75, target_propensity: 0.25 }));
    expect(r.ips_paise).toBeLessThan(r.observed_paise);
  });

  it('self-normalisation is more stable than raw importance sampling', () => {
    const rows = [
      ...logged(200, { logging_propensity: 0.5, target_propensity: 0.5, reward_paise: 10000 }),
      ...logged(5, { logging_propensity: 0.02, target_propensity: 0.9, reward_paise: 10000 }),
    ];
    const r = evaluateOffPolicy(rows);
    expect(Math.abs(r.snips_paise! - 10000)).toBeLessThan(Math.abs(r.ips_paise! - 10000));
  });
});

describe('it reports when the estimate should not be quoted', () => {
  it('flags no support when the effective sample size is tiny', () => {
    const rows = [
      ...logged(3, { logging_propensity: 0.01, target_propensity: 1, reward_paise: 90000 }),
      ...logged(2, { logging_propensity: 0.9, target_propensity: 0.01, reward_paise: 100 }),
    ];
    const r = evaluateOffPolicy(rows);
    expect(r.effective_sample_size).toBeLessThan(MIN_ESS);
    expect(r.support).toBe('no_support');
    expect(r.explanation).toContain('should not be quoted');
  });

  it('flags weak support in the middle band', () => {
    const rows = [
      ...logged(60, { logging_propensity: 0.5, target_propensity: 0.5 }),
      ...logged(8, { logging_propensity: 0.05, target_propensity: 0.9 }),
    ];
    const r = evaluateOffPolicy(rows);
    expect(['weak_support', 'no_support']).toContain(r.support);
  });

  it('always reports the effective sample size beside the estimate', () => {
    const r = evaluateOffPolicy(logged(300));
    expect(r.effective_sample_size).toBeGreaterThan(0);
    expect(r.explanation).toContain('Effective sample size');
  });

  it('clips extreme weights and says how many it clipped', () => {
    const rows = [
      ...logged(200, { logging_propensity: 0.5, target_propensity: 0.5 }),
      ...logged(4, { logging_propensity: 0.001, target_propensity: 1 }),
    ];
    const r = evaluateOffPolicy(rows);
    expect(r.clipped).toBe(4);
    expect(r.max_weight).toBeGreaterThan(WEIGHT_CLIP);
  });
});

describe('the doubly robust estimator uses the model where it can', () => {
  it('falls back to the model prediction when importance weights are small', () => {
    const rows = logged(300, {
      logging_propensity: 0.9,
      target_propensity: 0.05,
      reward_paise: 0,
      predicted_reward_paise: 8000,
    });
    const r = evaluateOffPolicy(rows);
    expect(r.doubly_robust_paise).toBeGreaterThan(r.ips_paise!);
  });

  it('behaves like importance sampling when no model prediction is supplied', () => {
    const r = evaluateOffPolicy(logged(300, { logging_propensity: 0.5, target_propensity: 0.5 }));
    expect(r.doubly_robust_paise).toBe(r.ips_paise);
  });
});

describe('exploration creates the support the estimator needs', () => {
  const ranked = ['best', 'second', 'third', 'fourth'];

  it('picks the best action most of the time and records its propensity', () => {
    const c = exploreAmong(ranked, 0.1, 0.5)!;
    expect(c.chosen).toBe('best');
    expect(c.propensity).toBeCloseTo(0.9, 5);
  });

  it('sometimes picks an alternative, with the smaller propensity recorded', () => {
    const c = exploreAmong(ranked, 0.3, 0.95)!;
    expect(c.chosen).not.toBe('best');
    expect(c.propensity).toBeCloseTo(0.1, 5);
  });

  it('is deterministic with epsilon zero, and says the propensity is one', () => {
    const c = exploreAmong(ranked, 0, 0.99)!;
    expect(c.chosen).toBe('best');
    expect(c.propensity).toBe(1);
  });

  it('reports propensity one when there is only one option to take', () => {
    const c = exploreAmong(['only'], 0.5, 0.99)!;
    expect(c.propensity).toBe(1);
  });

  it('returns null rather than inventing a choice from nothing', () => {
    expect(exploreAmong([], 0.2, 0.5)).toBeNull();
  });

  it('never returns an index outside the ranked list', () => {
    for (let d = 0; d < 1; d += 0.01) {
      const c = exploreAmong(ranked, 0.5, d)!;
      expect(ranked).toContain(c.chosen);
      expect(c.propensity).toBeGreaterThan(0);
    }
  });

  it('propensities across the draw space sum to one', () => {
    let bestDraws = 0;
    const counts = new Map<string, number>();
    const steps = 10000;
    for (let i = 0; i < steps; i += 1) {
      const c = exploreAmong(ranked, 0.2, i / steps)!;
      counts.set(c.chosen, (counts.get(c.chosen) ?? 0) + 1);
      if (c.chosen === 'best') bestDraws += 1;
    }
    expect(bestDraws / steps).toBeCloseTo(0.8, 1);
    expect(counts.size).toBeGreaterThan(1);
  });
});

describe('it is total', () => {
  it.each([
    ['a NaN propensity', { logging_propensity: Number.NaN }],
    ['a NaN reward', { reward_paise: Number.NaN }],
    ['a negative reward', { reward_paise: -5000 }],
    ['a zero target propensity', { target_propensity: 0 }],
  ])('does not throw on %s', (_label, over) => {
    const r = evaluateOffPolicy(logged(50, over));
    expect(r).toBeDefined();
    expect(r.explanation.length).toBeGreaterThan(20);
  });
});
