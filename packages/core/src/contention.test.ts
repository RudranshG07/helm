import { describe, expect, it } from 'vitest';
import {
  MIN_CELL_ATTEMPTS,
  amountEffect,
  dayBand,
  hourBand,
  medianAmount,
  splitByAmount,
  testContention,
} from './contention.ts';
import type { AttemptObservation } from './contention.ts';

function obs(n: number, opts: { amount: number; successRate: number; day?: number; hour?: number }): AttemptObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    day_of_month: opts.day ?? 1,
    hour: opts.hour ?? 0,
    amount_paise: opts.amount,
    succeeded: i / n < opts.successRate,
  }));
}

const N = MIN_CELL_ATTEMPTS * 4;

describe('banding', () => {
  it.each([[1, 'payday'], [3, 'payday'], [5, 'early'], [15, 'mid'], [28, 'late']] as const)(
    'day %i is %s', (d, band) => expect(dayBand(d)).toBe(band),
  );

  it.each([[2, 'night'], [8, 'morning'], [11, 'midday'], [15, 'afternoon'], [21, 'evening']] as const)(
    'hour %i is %s', (h, band) => expect(hourBand(h)).toBe(band),
  );
});

describe('amount split', () => {
  it('splits at the median of the combined population', () => {
    const all = [...obs(10, { amount: 10000, successRate: 1 }), ...obs(10, { amount: 90000, successRate: 1 })];
    expect(medianAmount(all)).toBe(50000);
  });

  it('puts equal-to-median amounts on the small side', () => {
    const split = splitByAmount(obs(4, { amount: 50000, successRate: 1 }), 50000);
    expect(split.small.attempts).toBe(4);
    expect(split.large.attempts).toBe(0);
  });

  it('reports null rates for an empty band rather than zero', () => {
    const effect = amountEffect(splitByAmount(obs(4, { amount: 100, successRate: 1 }), 50000));
    expect(effect.large_success_rate).toBeNull();
    expect(effect.gap).toBeNull();
  });

  it('handles an empty population without throwing', () => {
    expect(medianAmount([])).toBe(0);
    expect(() => amountEffect(splitByAmount([], 0))).not.toThrow();
  });
});

describe('the contention test', () => {
  it('detects contention when large debits fail disproportionately in the contested window', () => {
    const contested = [
      ...obs(N, { amount: 10000, successRate: 0.9 }),
      ...obs(N, { amount: 90000, successRate: 0.45 }),
    ];
    const uncontested = [
      ...obs(N, { amount: 10000, successRate: 0.9 }),
      ...obs(N, { amount: 90000, successRate: 0.88 }),
    ];

    const result = testContention(contested, uncontested);
    expect(result.verdict).toBe('contention');
    expect(result.differential).toBeGreaterThan(0);
    expect(result.explanation).toContain('residual balance');
  });

  it('reports funding when large and small fail alike in both windows', () => {
    const contested = [
      ...obs(N, { amount: 10000, successRate: 0.5 }),
      ...obs(N, { amount: 90000, successRate: 0.5 }),
    ];
    const uncontested = [
      ...obs(N, { amount: 10000, successRate: 0.9 }),
      ...obs(N, { amount: 90000, successRate: 0.9 }),
    ];

    const result = testContention(contested, uncontested);
    expect(result.verdict).not.toBe('contention');
  });

  it('reports funding when the amount effect points the other way', () => {
    const contested = [
      ...obs(N, { amount: 10000, successRate: 0.4 }),
      ...obs(N, { amount: 90000, successRate: 0.9 }),
    ];
    const uncontested = [
      ...obs(N, { amount: 10000, successRate: 0.9 }),
      ...obs(N, { amount: 90000, successRate: 0.9 }),
    ];

    expect(testContention(contested, uncontested).verdict).toBe('funding');
  });

  it('refuses to conclude anything below the volume floor', () => {
    const thin = [
      ...obs(5, { amount: 10000, successRate: 0.9 }),
      ...obs(5, { amount: 90000, successRate: 0.1 }),
    ];
    const result = testContention(thin, thin);
    expect(result.verdict).toBe('inconclusive_low_volume');
    expect(result.z).toBeNull();
  });

  it('says inconclusive rather than contention when the effect is present in both windows', () => {
    const same = [
      ...obs(N, { amount: 10000, successRate: 0.9 }),
      ...obs(N, { amount: 90000, successRate: 0.6 }),
    ];
    const result = testContention(same, [...same]);
    expect(result.verdict).toBe('inconclusive_no_difference');
  });

  it('does not claim contention on a difference that is within noise', () => {
    const contested = [
      ...obs(N, { amount: 10000, successRate: 0.90 }),
      ...obs(N, { amount: 90000, successRate: 0.87 }),
    ];
    const uncontested = [
      ...obs(N, { amount: 10000, successRate: 0.90 }),
      ...obs(N, { amount: 90000, successRate: 0.89 }),
    ];
    expect(testContention(contested, uncontested).verdict).toBe('inconclusive_no_difference');
  });

  it('always explains its verdict in words a merchant can read', () => {
    const result = testContention(obs(4, { amount: 100, successRate: 1 }), obs(4, { amount: 100, successRate: 1 }));
    expect(result.explanation.length).toBeGreaterThan(40);
  });

  it('never throws on degenerate input', () => {
    for (const pair of [[[], []], [obs(1, { amount: 0, successRate: 0 }), []]] as const) {
      expect(() => testContention(pair[0], pair[1])).not.toThrow();
    }
  });

  it('reports the threshold it split on, so the test is reproducible', () => {
    const contested = obs(N, { amount: 10000, successRate: 0.9 });
    const uncontested = obs(N, { amount: 90000, successRate: 0.9 });
    expect(testContention(contested, uncontested).threshold_paise).toBeGreaterThan(0);
  });
});
