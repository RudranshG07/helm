import { describe, expect, it } from 'vitest';
import { SimulatedGateway } from './simulator.ts';

const AT = new Date('2026-09-10T08:00:00.000Z');

function charge(gw: SimulatedGateway, receipt: string, at = AT) {
  return gw.createOrderAndCharge({
    receipt,
    amount_paise: 49900,
    subscription_id: 'sub',
    rzp_subscription_id: 'sub',
    scheduled_for: at,
  });
}

const fresh = () => new SimulatedGateway({ seed: 7, medianPaise: 40000 });

describe('one arm cannot change what happens to the other', () => {
  it('gives a receipt the same outcome regardless of what came before it', async () => {
    const a = fresh();
    const first = await charge(a, 'target');

    const b = fresh();
    for (const noise of ['x1', 'x2', 'x3', 'x4', 'x5']) await charge(b, noise);
    const later = await charge(b, 'target');

    expect(later.payment?.status).toBe(first.payment?.status);
  });

  it('is unaffected by how many other mandates were processed first', async () => {
    const outcomes = new Set<string>();
    for (const noiseCount of [0, 1, 7, 40]) {
      const gw = fresh();
      for (let i = 0; i < noiseCount; i += 1) await charge(gw, `noise_${i}`);
      const r = await charge(gw, 'target');
      outcomes.add(String(r.payment?.status));
    }
    expect(outcomes.size, 'outcome drifted with processing order').toBe(1);
  });

  it('still gives different receipts different draws', async () => {
    const gw = fresh();
    const results: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const r = await charge(gw, `r_${i}`);
      results.push(String(r.payment?.status));
    }
    expect(new Set(results).size, 'every draw identical means the seed is not mixing')
      .toBeGreaterThan(1);
  });

  it('is reproducible for a fixed seed', async () => {
    const one = fresh();
    const two = fresh();
    for (let i = 0; i < 20; i += 1) {
      const a = await charge(one, `r_${i}`);
      const b = await charge(two, `r_${i}`);
      expect(b.payment?.status).toBe(a.payment?.status);
    }
  });

  it('changes with the seed, so a run can be varied deliberately', async () => {
    const a = new SimulatedGateway({ seed: 1, medianPaise: 40000 });
    const b = new SimulatedGateway({ seed: 2, medianPaise: 40000 });
    const left: string[] = [];
    const right: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      left.push(String((await charge(a, `r_${i}`)).payment?.status));
      right.push(String((await charge(b, `r_${i}`)).payment?.status));
    }
    expect(left.join()).not.toBe(right.join());
  });

  it('still respects the timing model, so a better slot really is better', async () => {
    const peak = new Date('2026-09-10T06:00:00.000Z');
    const quiet = new Date('2026-09-10T09:30:00.000Z');
    let peakWins = 0;
    let quietWins = 0;
    for (let i = 0; i < 300; i += 1) {
      const gw = fresh();
      if ((await charge(gw, `p_${i}`, peak)).payment?.status === 'captured') peakWins += 1;
      if ((await charge(gw, `q_${i}`, quiet)).payment?.status === 'captured') quietWins += 1;
    }
    expect(quietWins).toBeGreaterThan(peakWins);
  });
});
