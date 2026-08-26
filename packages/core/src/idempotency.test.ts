import { describe, expect, it } from 'vitest';
import { idempotencyKey, orderReceipt, parseIdempotencyKey } from './idempotency.ts';

const cycle = new Date('2026-09-01T00:00:00.000Z');
const identity = { subscription_id: 'merchant_a:sub_1', cycle, attempt_number: 2 };

describe('idempotencyKey', () => {
  it('is deterministic across calls', () => {
    expect(idempotencyKey(identity)).toBe(idempotencyKey({ ...identity }));
  });

  it('is stable across process restarts, since it derives only from the domain', () => {
    expect(idempotencyKey(identity)).toBe('mr_merchant_a:sub_1_1788220800_2');
  });

  it('differs per attempt number', () => {
    expect(idempotencyKey({ ...identity, attempt_number: 3 })).not.toBe(idempotencyKey(identity));
  });

  it('differs per cycle', () => {
    const next = { ...identity, cycle: new Date('2026-10-01T00:00:00.000Z') };
    expect(idempotencyKey(next)).not.toBe(idempotencyKey(identity));
  });

  it('differs per subscription', () => {
    expect(idempotencyKey({ ...identity, subscription_id: 'x' })).not.toBe(idempotencyKey(identity));
  });

  it('ignores sub-second cycle drift, so a re-read of the same cycle collides as intended', () => {
    const drifted = { ...identity, cycle: new Date(cycle.getTime() + 999) };
    expect(idempotencyKey(drifted)).toBe(idempotencyKey(identity));
  });

  it('refuses inputs that would produce a non-colliding key', () => {
    expect(() => idempotencyKey({ ...identity, subscription_id: '' })).toThrow();
    expect(() => idempotencyKey({ ...identity, attempt_number: 0 })).toThrow();
    expect(() => idempotencyKey({ ...identity, attempt_number: 1.5 })).toThrow();
    expect(() => idempotencyKey({ ...identity, cycle: new Date('invalid') })).toThrow();
  });
});

describe('orderReceipt', () => {
  it('matches the idempotency key when it fits Razorpay\'s receipt length', () => {
    expect(orderReceipt(identity)).toBe(idempotencyKey(identity));
  });

  it('stays inside 40 characters even for a long subscription id', () => {
    const long = { ...identity, subscription_id: 'merchant_with_a_very_long_name:sub_ABCDEFGH12345678' };
    expect(orderReceipt(long).length).toBeLessThanOrEqual(40);
  });

  it('stays deterministic after truncation', () => {
    const long = { ...identity, subscription_id: 'merchant_with_a_very_long_name:sub_ABCDEFGH12345678' };
    expect(orderReceipt(long)).toBe(orderReceipt({ ...long }));
  });

  it('still separates attempts after truncation', () => {
    const long = { ...identity, subscription_id: 'merchant_with_a_very_long_name:sub_ABCDEFGH12345678' };
    expect(orderReceipt(long)).not.toBe(orderReceipt({ ...long, attempt_number: 3 }));
  });

  it('still separates subscriptions after truncation', () => {
    const a = { ...identity, subscription_id: 'merchant_with_a_very_long_name:sub_AAAAAAAA11111111' };
    const b = { ...identity, subscription_id: 'merchant_with_a_very_long_name:sub_BBBBBBBB22222222' };
    expect(orderReceipt(a)).not.toBe(orderReceipt(b));
  });
});

describe('parseIdempotencyKey', () => {
  it('round-trips a key back to its identity', () => {
    const parsed = parseIdempotencyKey(idempotencyKey(identity));
    expect(parsed?.subscription_id).toBe(identity.subscription_id);
    expect(parsed?.attempt_number).toBe(2);
    expect(parsed?.cycle.toISOString()).toBe(cycle.toISOString());
  });

  it('returns null on anything that is not our key', () => {
    for (const bad of ['', 'order_123', 'mr_nope', 'mr__1_1']) {
      expect(parseIdempotencyKey(bad)).toBeNull();
    }
  });
});
