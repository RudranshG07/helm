import { describe, expect, it } from 'vitest';
import { SuccessModel, lagBand } from './success-model.ts';
import type { Outcome, Slot } from './success-model.ts';

function slot(over: Partial<Slot> = {}): Slot {
  return {
    bucket: 'SOFT_LIQUIDITY',
    issuer: 'HDFC',
    method: 'upi_autopay',
    day_of_month: 5,
    hour: 14,
    days_since_failure: 1,
    amount_paise: 50000,
    ...over,
  };
}

function outcomes(n: number, rate: number, over: Partial<Slot> = {}): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({ ...slot(over), succeeded: i / n < rate }));
}

describe('lag banding', () => {
  it.each([[0, 'same_day'], [1, 'next_day'], [3, 'few_days'], [10, 'week_plus']] as const)(
    '%i days is %s', (d, band) => expect(lagBand(d)).toBe(band),
  );
});

describe('cold start', () => {
  it('returns a usable prior with no data at all', () => {
    const p = new SuccessModel([]).predict(slot());
    expect(p.p).toBeGreaterThan(0);
    expect(p.p).toBeLessThan(1);
    expect(p.level).toBe('prior');
    expect(p.evidence).toBe(0);
  });

  it('borrows from a coarser level when the exact cell is empty', () => {
    const model = new SuccessModel(outcomes(200, 0.9, { issuer: 'ICICI', hour: 3 }));
    const p = model.predict(slot({ issuer: 'HDFC', hour: 3 }));
    expect(p.p).toBeGreaterThan(0.5);
    expect(p.level).not.toBe('cell');
  });
});

describe('learning', () => {
  it('moves toward the observed rate as evidence accumulates', () => {
    const background = outcomes(400, 0.9, { hour: 9 });
    const thin = new SuccessModel([...background, ...outcomes(5, 0.0, { hour: 14 })]).predict(slot({ hour: 14 }));
    const thick = new SuccessModel([...background, ...outcomes(500, 0.0, { hour: 14 })]).predict(slot({ hour: 14 }));
    expect(thick.p).toBeLessThan(thin.p);
  });

  it('shrinks a small sample toward its parent rather than trusting it', () => {
    const model = new SuccessModel([
      ...outcomes(400, 0.8, { hour: 14 }),
      ...outcomes(3, 0.0, { hour: 21 }),
    ]);
    const sparse = model.predict(slot({ hour: 21 }));
    expect(sparse.p).toBeGreaterThan(0.3);
  });

  it('separates issuers once each has its own evidence', () => {
    const model = new SuccessModel([
      ...outcomes(300, 0.95, { issuer: 'HDFC' }),
      ...outcomes(300, 0.15, { issuer: 'SBI' }),
    ]);
    expect(model.predict(slot({ issuer: 'HDFC' })).p).toBeGreaterThan(
      model.predict(slot({ issuer: 'SBI' })).p,
    );
  });

  it('separates time slots once each has its own evidence', () => {
    const model = new SuccessModel([
      ...outcomes(300, 0.9, { day_of_month: 5, hour: 14 }),
      ...outcomes(300, 0.1, { day_of_month: 1, hour: 2 }),
    ]);
    expect(model.predict(slot({ day_of_month: 5, hour: 14 })).p).toBeGreaterThan(
      model.predict(slot({ day_of_month: 1, hour: 2 })).p,
    );
  });

  it('updates incrementally', () => {
    const model = new SuccessModel(outcomes(100, 0.5));
    const before = model.predict(slot()).p;
    for (let i = 0; i < 200; i += 1) model.observe({ ...slot(), succeeded: true });
    expect(model.predict(slot()).p).toBeGreaterThan(before);
  });
});

describe('uncertainty', () => {
  it('reports a wider interval on thin evidence than on thick', () => {
    const thin = new SuccessModel(outcomes(4, 0.5)).predict(slot());
    const thick = new SuccessModel(outcomes(800, 0.5)).predict(slot());
    expect(thin.high - thin.low).toBeGreaterThan(thick.high - thick.low);
  });

  it('keeps the interval inside zero and one', () => {
    const p = new SuccessModel(outcomes(500, 1)).predict(slot());
    expect(p.low).toBeGreaterThanOrEqual(0);
    expect(p.high).toBeLessThanOrEqual(1);
  });

  it('names the level it answered from, so a caller can weigh it', () => {
    const model = new SuccessModel(outcomes(200, 0.9));
    expect(model.predict(slot()).level).toBe('cell');
  });
});

describe('it is total', () => {
  it.each([
    ['a negative lag', { days_since_failure: -5 }],
    ['an absurd day', { day_of_month: 99 }],
    ['an absurd hour', { hour: 99 }],
    ['a null issuer', { issuer: null }],
    ['a zero amount', { amount_paise: 0 }],
  ])('does not throw on %s', (_label, over) => {
    const p = new SuccessModel(outcomes(20, 0.5)).predict(slot(over));
    expect(Number.isFinite(p.p)).toBe(true);
    expect(p.p).toBeGreaterThanOrEqual(0);
    expect(p.p).toBeLessThanOrEqual(1);
  });
});
