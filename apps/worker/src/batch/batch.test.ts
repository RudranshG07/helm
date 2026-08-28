import { describe, expect, it } from 'vitest';
import { toIstParts } from '@mandate/core';
import { generateMandates, runBatch } from './run.ts';
import { renderBatch } from './report.ts';
import { DEFAULT_MODEL, mulberry32, successProbability } from './simulator.ts';

describe('the simulator encodes the contention hypothesis, and says so', () => {
  const median = 50000;
  const payday = new Date(Date.UTC(2026, 8, 0, 19, 0));
  const afternoon = new Date(Date.UTC(2026, 8, 1, 9, 0));

  it('penalises the contested window on payday', () => {
    expect(successProbability(payday, median, median)).toBeLessThan(
      successProbability(afternoon, median, median),
    );
  });

  it('penalises a large debit more than a small one inside that window', () => {
    const small = successProbability(payday, median / 2, median);
    const large = successProbability(payday, median * 3, median);
    expect(large).toBeLessThan(small);
  });

  it('does not penalise a large debit outside the window', () => {
    const small = successProbability(afternoon, median / 2, median);
    const large = successProbability(afternoon, median * 3, median);
    expect(large).toBe(small);
  });

  it('keeps every probability inside zero and one', () => {
    for (let day = 1; day <= 31; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const at = new Date(Date.UTC(2026, 8, day, hour, 0));
        const p = successProbability(at, 5_000_000, median);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }
    }
  });
});

describe('the random source is seeded', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces a different sequence for a different seed', () => {
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
  });
});

describe('the batch is a paired comparison', () => {
  const result = runBatch({ count: 60, seed: 99 });

  it('runs both arms over the identical mandate population', () => {
    expect(result.control.mandates).toBe(result.treatment.mandates);
    expect(result.control.amount_at_risk_paise).toBe(result.treatment.amount_at_risk_paise);
  });

  it('is reproducible for a fixed seed', () => {
    const again = runBatch({ count: 60, seed: 99 });
    expect(again.control).toEqual(result.control);
    expect(again.treatment).toEqual(result.treatment);
  });

  it('changes when the seed changes', () => {
    const other = runBatch({ count: 60, seed: 1234 });
    expect(other.control.amount_at_risk_paise).not.toBe(result.control.amount_at_risk_paise);
  });

  it('never recovers more than was at risk', () => {
    for (const arm of [result.control, result.treatment]) {
      expect(arm.amount_recovered_paise).toBeLessThanOrEqual(arm.amount_at_risk_paise);
    }
  });

  it('never spends more attempts than the budget allows', () => {
    for (const arm of [result.control, result.treatment]) {
      expect(arm.attempts_spent).toBeLessThanOrEqual(arm.mandates * 3);
    }
  });

  it('accounts for every mandate as recovered or halted', () => {
    for (const arm of [result.control, result.treatment]) {
      expect(arm.mandates_recovered + arm.mandates_halted).toBe(arm.mandates);
    }
  });

  it('generates mandates whose failures land in the contested window', () => {
    const mandates = generateMandates(50, 1, new Date());
    for (const m of mandates) {
      const ist = toIstParts(m.first_failure_at);
      expect(DEFAULT_MODEL.payday_days).toContain(ist.day);
      expect(ist.hour).toBeLessThan(6);
    }
  });
});

describe('the report cannot hide a bad result', () => {
  const md = renderBatch(runBatch({ count: 60, seed: 99 }));

  it('labels simulated numbers as simulated, up front', () => {
    expect(md.indexOf('Simulated')).toBeLessThan(200);
    expect(md).toContain('did not reach Razorpay');
  });

  it('prints the denominator beside the recovery figure', () => {
    expect(md).toContain('denominator');
  });

  it('states the full generative model rather than burying the assumptions', () => {
    expect(md).toContain('amount_sensitivity');
    expect(md).toContain('contention_penalty');
  });

  it('says what the result does not establish', () => {
    expect(md).toContain('does not** establish');
  });

  it('reports the halt tradeoff when treatment halts more', () => {
    const result = runBatch({ count: 60, seed: 99 });
    if (result.treatment.mandates_halted > result.control.mandates_halted) {
      expect(md).toContain('The tradeoff, stated plainly');
      expect(md).toContain('reported here rather than tuned away');
    }
  });

  it('computes whether the trade is favourable rather than asserting it', () => {
    const favourable = md.includes('**favourable**');
    const unfavourable = md.includes('**unfavourable**');
    expect(favourable !== unfavourable).toBe(true);
  });
});
