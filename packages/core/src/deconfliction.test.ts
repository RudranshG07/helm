import { describe, expect, it } from 'vitest';
import { COLLISION_WINDOW_MS, deconflict, findCollisions } from './deconfliction.ts';
import type { ScheduledDebit } from './deconfliction.ts';
import { fromIst, isPeak, toIstParts } from './time.ts';

function debit(over: Partial<ScheduledDebit> & { id: string }): ScheduledDebit {
  const at = over.at ?? fromIst(2026, 8, 1, 2 * 60);
  return {
    merchant_id: 'm1',
    customer_key: 'cust_shared',
    amount_paise: 50000,
    at,
    earliest: at,
    latest: fromIst(2026, 8, 5, 22 * 60),
    ...over,
  };
}

const PAYDAY_MIDNIGHT = fromIst(2026, 8, 1, 5);

describe('collision detection', () => {
  it('finds debits landing on the same account within the window', () => {
    const c = findCollisions([
      debit({ id: 'a', merchant_id: 'gym', at: PAYDAY_MIDNIGHT }),
      debit({ id: 'b', merchant_id: 'sip', at: new Date(PAYDAY_MIDNIGHT.getTime() + 5 * 60_000) }),
      debit({ id: 'c', merchant_id: 'ott', at: new Date(PAYDAY_MIDNIGHT.getTime() + 10 * 60_000) }),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.debits).toHaveLength(3);
    expect(c[0]!.total_paise).toBe(150000);
  });

  it('does not call debits outside the window a collision', () => {
    const c = findCollisions([
      debit({ id: 'a', at: PAYDAY_MIDNIGHT }),
      debit({ id: 'b', at: new Date(PAYDAY_MIDNIGHT.getTime() + COLLISION_WINDOW_MS + 60_000) }),
    ]);
    expect(c).toHaveLength(0);
  });

  it('never treats different customers as colliding, however close in time', () => {
    const c = findCollisions([
      debit({ id: 'a', customer_key: 'one', at: PAYDAY_MIDNIGHT }),
      debit({ id: 'b', customer_key: 'two', at: PAYDAY_MIDNIGHT }),
    ]);
    expect(c).toHaveLength(0);
  });

  it('a single debit is never a collision', () => {
    expect(findCollisions([debit({ id: 'a' })])).toHaveLength(0);
  });

  it('handles an empty schedule', () => {
    expect(findCollisions([])).toEqual([]);
  });
});

describe('de-confliction is positive sum, not a fight over the balance', () => {
  const colliding = [
    debit({ id: 'gym', merchant_id: 'gym', amount_paise: 50000, at: PAYDAY_MIDNIGHT }),
    debit({ id: 'sip', merchant_id: 'sip', amount_paise: 500000, at: PAYDAY_MIDNIGHT }),
    debit({ id: 'ott', merchant_id: 'ott', amount_paise: 19900, at: PAYDAY_MIDNIGHT }),
    debit({ id: 'emi', merchant_id: 'emi', amount_paise: 250000, at: PAYDAY_MIDNIGHT }),
  ];

  it('clears every collision it can', () => {
    const r = deconflict(colliding);
    expect(r.collisions_before).toBeGreaterThan(0);
    expect(r.collisions_after).toBe(0);
  });

  it('keeps every merchant, dropping none', () => {
    const r = deconflict(colliding);
    expect(r.assignments).toHaveLength(colliding.length);
    expect(new Set(r.assignments.map((a) => a.id)).size).toBe(4);
  });

  it('gives the earliest slot to the largest debit, which needs the most headroom', () => {
    const r = deconflict(colliding);
    const byId = new Map(r.assignments.map((a) => [a.id, a.assigned_at.getTime()]));
    expect(byId.get('sip')).toBeLessThanOrEqual(byId.get('emi')!);
    expect(byId.get('emi')).toBeLessThanOrEqual(byId.get('ott')!);
  });

  it('never moves a debit outside its own permitted window', () => {
    const r = deconflict(colliding);
    for (const a of r.assignments) {
      const source = colliding.find((d) => d.id === a.id)!;
      expect(a.assigned_at.getTime()).toBeGreaterThanOrEqual(source.earliest.getTime());
      expect(a.assigned_at.getTime()).toBeLessThanOrEqual(source.latest.getTime());
    }
  });

  it('never places a debit inside a peak execution window', () => {
    const r = deconflict(colliding);
    for (const a of r.assignments) expect(isPeak(a.assigned_at)).toBe(false);
  });

  it('leaves an already-clear schedule untouched', () => {
    const spread = [
      debit({ id: 'a', at: fromIst(2026, 8, 1, 2 * 60) }),
      debit({ id: 'b', at: fromIst(2026, 8, 1, 14 * 60) }),
      debit({ id: 'c', at: fromIst(2026, 8, 1, 22 * 60) }),
    ];
    const r = deconflict(spread);
    expect(r.debits_moved).toBe(0);
    expect(r.collisions_after).toBe(0);
  });

  it('explains every move in terms a merchant can read', () => {
    const r = deconflict(colliding);
    for (const a of r.assignments) {
      expect(a.reason.length).toBeGreaterThan(20);
      if (a.moved) expect(a.reason).toContain('same account');
    }
  });

  it('reports what it could not resolve rather than forcing a bad slot', () => {
    const boxed = [
      debit({ id: 'a', at: PAYDAY_MIDNIGHT, latest: fromIst(2026, 8, 1, 5) }),
      debit({ id: 'b', at: PAYDAY_MIDNIGHT, latest: fromIst(2026, 8, 1, 5) }),
      debit({ id: 'c', at: PAYDAY_MIDNIGHT, latest: fromIst(2026, 8, 1, 5) }),
    ];
    const r = deconflict(boxed);
    expect(r.unresolvable.length).toBeGreaterThan(0);
    const stuck = r.assignments.find((a) => r.unresolvable.includes(a.id))!;
    expect(stuck.reason).toContain('No legal slot');
  });

  it('scales across many customers without mixing them up', () => {
    const many: ScheduledDebit[] = [];
    for (let c = 0; c < 30; c += 1) {
      for (let m = 0; m < 4; m += 1) {
        many.push(debit({
          id: `c${c}_m${m}`,
          customer_key: `cust_${c}`,
          merchant_id: `m${m}`,
          amount_paise: 10000 * (m + 1),
          at: PAYDAY_MIDNIGHT,
        }));
      }
    }
    const r = deconflict(many);
    expect(r.collisions_before).toBe(30);
    expect(r.collisions_after).toBe(0);
    expect(r.assignments).toHaveLength(120);
  });

  it('is deterministic', () => {
    const a = deconflict(colliding);
    const b = deconflict(colliding);
    expect(b.assignments.map((x) => x.assigned_at.toISOString()))
      .toEqual(a.assignments.map((x) => x.assigned_at.toISOString()));
  });

  it('does not mutate the input schedule', () => {
    const original = colliding[0]!.at.getTime();
    deconflict(colliding);
    expect(colliding[0]!.at.getTime()).toBe(original);
  });

  it('spreads debits across the day rather than stacking them a minute apart', () => {
    const r = deconflict(colliding);
    const times = r.assignments.map((a) => a.assigned_at.getTime()).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it('keeps every assignment on a real IST clock time', () => {
    const r = deconflict(colliding);
    for (const a of r.assignments) {
      const p = toIstParts(a.assigned_at);
      expect(p.hour).toBeGreaterThanOrEqual(0);
      expect(p.hour).toBeLessThan(24);
    }
  });
});
