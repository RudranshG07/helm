import { describe, expect, it } from 'vitest';
import { circularMean, clampToMonth, inferLiquidityWindow } from './liquidity.ts';

describe('circularMean handles the month boundary', () => {
  it('does not average the 1st and the 31st into the middle of the month', () => {
    const stat = circularMean([1, 31, 1, 31, 1, 31]);
    expect(stat).not.toBeNull();
    expect([30, 31, 1, 2]).toContain(stat!.day);
  });

  it('finds a tight cluster', () => {
    const stat = circularMean([2, 3, 3, 2, 3, 4]);
    expect(stat!.day).toBeGreaterThanOrEqual(2);
    expect(stat!.day).toBeLessThanOrEqual(4);
    expect(stat!.concentration).toBeGreaterThan(0.9);
  });

  it('reports low concentration for scattered payments', () => {
    expect(circularMean([1, 9, 17, 25])!.concentration).toBeLessThan(0.4);
  });

  it('returns null on empty or invalid input rather than guessing', () => {
    expect(circularMean([])).toBeNull();
    expect(circularMean([0, 45, Number.NaN])).toBeNull();
  });
});

describe('inferLiquidityWindow falls back honestly', () => {
  it('uses own history at high confidence with six or more successes', () => {
    const w = inferLiquidityWindow([2, 3, 3, 2, 3, 2]);
    expect(w.tier).toBe('own_history');
    expect(w.confidence).toBeGreaterThan(0.5);
  });

  it('uses own history but caps confidence with three to five successes', () => {
    const w = inferLiquidityWindow([2, 3, 3]);
    expect(w.tier).toBe('own_history');
    expect(w.confidence).toBeLessThanOrEqual(0.55);
  });

  it('drops to merchant default with too little personal history', () => {
    const w = inferLiquidityWindow([5], [1, 2, 1, 2, 3, 1]);
    expect(w.tier).toBe('merchant_default');
    expect(w.confidence).toBeLessThan(0.4);
  });

  it('drops to population default when nothing is known', () => {
    const w = inferLiquidityWindow([]);
    expect(w.tier).toBe('population_default');
    expect(w.window_days).toEqual([1, 5]);
    expect(w.confidence).toBeLessThan(0.2);
  });

  it('widens the window when the customer pays erratically', () => {
    const tight = inferLiquidityWindow([3, 3, 3, 3, 3, 3]);
    const loose = inferLiquidityWindow([1, 6, 12, 3, 20, 8]);
    const span = (w: typeof tight) => {
      const [lo, hi] = w.window_days!;
      return hi >= lo ? hi - lo : 31 - lo + hi;
    };
    expect(span(loose)).toBeGreaterThan(span(tight));
  });

  it('always reports the sample size behind the claim', () => {
    expect(inferLiquidityWindow([2, 3, 4]).sample_size).toBe(3);
  });

  it('never throws on hostile input', () => {
    for (const input of [[], [0], [99], [Number.NaN], [-1, 400]]) {
      expect(() => inferLiquidityWindow(input)).not.toThrow();
    }
  });
});

describe('clampToMonth', () => {
  it('clamps the 31st to the end of February', () => {
    expect(clampToMonth(31, 2026, 1)).toBe(28);
  });
  it('handles a leap February', () => {
    expect(clampToMonth(31, 2028, 1)).toBe(29);
  });
  it('leaves a valid day alone', () => {
    expect(clampToMonth(15, 2026, 8)).toBe(15);
  });
});
