import { describe, expect, it } from 'vitest';
import {
  isQuietHours, maskRecipient, nextSendableTime, outreachExpiry,
  outreachIdempotencyKey, outreachToken, pickChannel,
} from './outreach.ts';

const ist = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 7, 27, h - 5, m - 30, 0));

describe('a recovery message must not arrive in the middle of the night', () => {
  it.each([[9, false], [12, false], [20, false], [20.5, false], [21, true], [23, true], [2, true], [8, true]])
    ('%s:00 IST quiet=%s', (hour, quiet) => {
      expect(isQuietHours(ist(Math.floor(hour), (hour % 1) * 60))).toBe(quiet);
    });

  it('leaves a permitted time alone', () => {
    const at = ist(14);
    expect(nextSendableTime(at).getTime()).toBe(at.getTime());
  });

  it('moves a late-night message to 9am the next morning', () => {
    const at = ist(23);
    const next = nextSendableTime(at);
    expect(next.getTime()).toBeGreaterThan(at.getTime());
    expect(isQuietHours(next)).toBe(false);
  });

  it('moves an early-morning message forward to the same morning', () => {
    const at = ist(3);
    const next = nextSendableTime(at);
    expect(next.getTime() - at.getTime()).toBeLessThan(24 * 3600 * 1000);
    expect(isQuietHours(next)).toBe(false);
  });
});

describe('a customer identifier never gets stored in the clear', () => {
  it('masks an email but keeps the domain legible', () => {
    expect(maskRecipient('priya.sharma@example.com')).toBe('pr**********@example.com');
  });

  it('masks a phone number to its last four digits', () => {
    expect(maskRecipient('+91 98765 43210')).toBe('********3210');
  });

  it('returns nothing when there is nothing to mask', () => {
    expect(maskRecipient(null)).toBeNull();
    expect(maskRecipient(undefined)).toBeNull();
  });
});

describe('the same decision can only ever produce one message', () => {
  it('derives the same key from the same decision', () => {
    const a = { subscription_id: 's1', cycle: new Date('2026-08-01'), decision_id: 7 };
    expect(outreachIdempotencyKey(a)).toBe(outreachIdempotencyKey({ ...a }));
  });

  it('derives a different key for a different cycle', () => {
    const base = { subscription_id: 's1', decision_id: 7 };
    expect(outreachIdempotencyKey({ ...base, cycle: new Date('2026-08-01') }))
      .not.toBe(outreachIdempotencyKey({ ...base, cycle: new Date('2026-09-01') }));
  });

  it('derives a different key for a different subscription', () => {
    const base = { cycle: new Date('2026-08-01'), decision_id: 7 };
    expect(outreachIdempotencyKey({ ...base, subscription_id: 'a' }))
      .not.toBe(outreachIdempotencyKey({ ...base, subscription_id: 'b' }));
  });

  it('issues an unguessable token each time', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => outreachToken()));
    expect(tokens.size).toBe(200);
    expect([...tokens][0]!.length).toBeGreaterThanOrEqual(32);
  });
});

describe('a recovery link must not outlive its purpose', () => {
  it('expires within the default window', () => {
    const at = new Date('2026-08-27T12:00:00Z');
    const exp = outreachExpiry(at, null);
    expect(exp.getTime()).toBeGreaterThan(at.getTime());
    expect(exp.getTime() - at.getTime()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  it('never outlives the billing cycle it belongs to', () => {
    const at = new Date('2026-08-27T12:00:00Z');
    const cycleEnd = new Date('2026-08-29T00:00:00Z');
    expect(outreachExpiry(at, cycleEnd).getTime()).toBe(cycleEnd.getTime());
  });
});

describe('channel selection', () => {
  it('prefers email when one exists', () => {
    expect(pickChannel('a@b.com', '9876543210')).toBe('email');
  });

  it('falls back to sms', () => {
    expect(pickChannel(null, '9876543210')).toBe('sms');
  });

  it('reports none rather than guessing', () => {
    expect(pickChannel(null, null)).toBe('none');
    expect(pickChannel('not-an-email', '123')).toBe('none');
  });
});
