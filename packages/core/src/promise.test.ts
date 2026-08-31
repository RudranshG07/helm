import { describe, expect, it } from 'vitest';
import { checkPromise, promiseAttemptTime, promiseReliability } from './promise.ts';

const NOW = new Date('2026-09-01T09:00:00.000Z');
const CYCLE_END = new Date('2026-09-25T00:00:00.000Z');
const check = (promised_for: string, cycle_end: Date | null = CYCLE_END) =>
  checkPromise({ promised_for, now: NOW, cycle_end });

describe('a promise is only accepted if it is one we could actually honour', () => {
  it('accepts a date a few days out', () => {
    expect(check('2026-09-05').ok).toBe(true);
  });

  it('accepts today, because the customer may be paid this morning', () => {
    expect(check('2026-09-01').ok).toBe(true);
  });

  it('refuses a date that has already passed', () => {
    const r = check('2026-08-30');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('passed');
  });

  it('refuses a date beyond the horizon we would wait', () => {
    const r = check('2026-11-01');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('within');
  });

  it('refuses a date after the mandate would already be cancelled', () => {
    const r = check('2026-09-20', new Date('2026-09-10T00:00:00.000Z'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('cancelled');
  });

  it.each(['not-a-date', '2026-13-01', '2026-02-30', '', '05/09/2026'])
    ('refuses malformed input %j', (bad) => {
      expect(check(bad).ok).toBe(false);
    });

  it('schedules the attempt inside business hours, not midnight', () => {
    const r = check('2026-09-05');
    if (!r.ok) throw new Error('expected ok');
    expect(r.attempt_at.toISOString()).toBe('2026-09-05T05:30:00.000Z');
  });
});

describe('a stored promise can be read back without re-validating it', () => {
  it('resolves a date recorded long ago', () => {
    expect(promiseAttemptTime('2026-09-05')?.toISOString()).toBe('2026-09-05T05:30:00.000Z');
  });

  it('returns nothing for a corrupt value', () => {
    expect(promiseAttemptTime('garbage')).toBeNull();
  });
});

describe('promise reliability becomes a signal about the customer', () => {
  it('reports nothing confident from an empty history', () => {
    const r = promiseReliability([]);
    expect(r.rate).toBe(0);
    expect(r.confident).toBe(false);
  });

  it('ignores promises that are still open', () => {
    const r = promiseReliability([
      { promised_for: '2026-09-05', status: 'open' },
      { promised_for: '2026-08-05', status: 'kept' },
    ]);
    expect(r.kept).toBe(1);
    expect(r.rate).toBe(1);
  });

  it('scores a customer who keeps their word', () => {
    const r = promiseReliability([
      { promised_for: '2026-06-05', status: 'kept' },
      { promised_for: '2026-07-05', status: 'kept' },
      { promised_for: '2026-08-05', status: 'kept' },
    ]);
    expect(r.rate).toBe(1);
    expect(r.confident).toBe(true);
  });

  it('scores a customer who does not', () => {
    const r = promiseReliability([
      { promised_for: '2026-06-05', status: 'broken' },
      { promised_for: '2026-07-05', status: 'broken' },
      { promised_for: '2026-08-05', status: 'kept' },
    ]);
    expect(r.rate).toBeCloseTo(1 / 3, 5);
    expect(r.confident).toBe(true);
  });

  it('refuses to be confident on a thin history', () => {
    expect(promiseReliability([{ promised_for: '2026-08-05', status: 'kept' }]).confident).toBe(false);
  });
});
