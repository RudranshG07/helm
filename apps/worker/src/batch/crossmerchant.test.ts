import { describe, expect, it } from 'vitest';
import {
  DEMO_MERCHANT_NAMES, PENDING_SHARE, SHARED_CUSTOMER_SHARE,
  customerKeyFor, merchantForIndex, merchantIdsFor,
} from './live.ts';

describe('the demonstration population spans more than one merchant', () => {
  it('derives merchant ids from a prefix rather than naming them inline', () => {
    const ids = merchantIdsFor('demo');
    expect(ids).toHaveLength(DEMO_MERCHANT_NAMES.length);
    for (const id of ids) expect(id.startsWith('demo_')).toBe(true);
  });

  it('can be narrowed to fewer merchants', () => {
    expect(merchantIdsFor('demo', 1)).toHaveLength(1);
    expect(merchantIdsFor('demo', 2)).toHaveLength(2);
  });

  it('never produces zero merchants, whatever it is asked for', () => {
    expect(merchantIdsFor('demo', 0).length).toBeGreaterThan(0);
    expect(merchantIdsFor('demo', -3).length).toBeGreaterThan(0);
  });

  it('spreads mandates evenly rather than piling them on one merchant', () => {
    const ids = merchantIdsFor('demo');
    const counts = new Map<string, number>();
    for (let i = 0; i < 60; i += 1) {
      const m = merchantForIndex(i, ids);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    expect(counts.size).toBe(ids.length);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });
});

describe('some customers are shared, because that is the whole point', () => {
  const ids = merchantIdsFor('demo');
  const total = 60;

  function sharing() {
    const seen = new Map<string, Set<string>>();
    for (let i = 0; i < total; i += 1) {
      const key = customerKeyFor(i, total);
      const set = seen.get(key) ?? new Set<string>();
      set.add(merchantForIndex(i, ids));
      seen.set(key, set);
    }
    return seen;
  }

  it('produces customers that more than one merchant debits', () => {
    const shared = [...sharing().values()].filter((s) => s.size > 1);
    expect(shared.length).toBeGreaterThan(0);
  });

  it('still leaves most customers with a single merchant', () => {
    const map = sharing();
    const solo = [...map.values()].filter((s) => s.size === 1).length;
    expect(solo).toBeGreaterThan(map.size / 2);
  });

  it('is deterministic, so a rerun describes the same population', () => {
    for (let i = 0; i < total; i += 1) {
      expect(customerKeyFor(i, total)).toBe(customerKeyFor(i, total));
    }
  });

  it('keeps the shared and pending shares as stated proportions, not magic numbers', () => {
    expect(SHARED_CUSTOMER_SHARE).toBeGreaterThan(0);
    expect(SHARED_CUSTOMER_SHARE).toBeLessThan(1);
    expect(PENDING_SHARE).toBeGreaterThan(0);
    expect(PENDING_SHARE).toBeLessThan(1);
  });

  it('scales the shared pool with the population rather than fixing a count', () => {
    const small = new Set(Array.from({ length: 20 }, (_, i) => customerKeyFor(i, 20)));
    const large = new Set(Array.from({ length: 200 }, (_, i) => customerKeyFor(i, 200)));
    expect(large.size).toBeGreaterThan(small.size);
  });
});
