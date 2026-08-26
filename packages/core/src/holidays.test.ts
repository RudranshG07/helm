import { describe, expect, it } from 'vitest';
import { ListHolidayCalendar, istDateKey, shiftForBankHoliday } from './holidays.ts';

const HOLIDAYS = ['2026-10-02', '2026-10-20', '2026-10-21'];
const cal = new ListHolidayCalendar(HOLIDAYS);

function ist(iso: string): Date {
  return new Date(`${iso}T04:30:00.000Z`);
}

describe('the calendar', () => {
  it('recognises a listed holiday', () => {
    expect(cal.isHoliday(ist('2026-10-02'))).toBe(true);
  });

  it('treats every Sunday as non-working', () => {
    expect(cal.isHoliday(ist('2026-10-04'))).toBe(true);
  });

  it('treats the second and fourth Saturday as non-working, not every Saturday', () => {
    expect(cal.isHoliday(ist('2026-10-10'))).toBe(true);
    expect(cal.isHoliday(ist('2026-10-24'))).toBe(true);
    expect(cal.isHoliday(ist('2026-10-03'))).toBe(false);
    expect(cal.isHoliday(ist('2026-10-17'))).toBe(false);
  });

  it('reads the date in IST, not UTC', () => {
    expect(istDateKey(new Date('2026-10-01T20:30:00.000Z'))).toBe('2026-10-02');
  });

  it('reports which years it actually covers, so a gap is visible', () => {
    expect(cal.coversYear(2026)).toBe(true);
    expect(cal.coversYear(2027)).toBe(false);
  });
});

describe('shiftForBankHoliday', () => {
  it('leaves a working day alone', () => {
    const target = ist('2026-10-06');
    const result = shiftForBankHoliday(target, cal);
    expect(result.shifted).toBe(false);
    expect(result.date).toBe(target);
  });

  it('moves a holiday back one day', () => {
    const result = shiftForBankHoliday(ist('2026-10-02'), cal);
    expect(result.shifted).toBe(true);
    if (result.shifted) {
      expect(result.days).toBe(-1);
      expect(istDateKey(result.date)).toBe('2026-10-01');
    }
  });

  it('moves back three days when the day before is also a holiday', () => {
    const result = shiftForBankHoliday(ist('2026-10-21'), cal);
    expect(result.shifted).toBe(true);
    if (result.shifted) {
      expect(result.days).toBe(-3);
      expect(istDateKey(result.date)).toBe('2026-10-18');
    }
  });

  it('handles a Monday holiday following a Sunday', () => {
    const result = shiftForBankHoliday(ist('2026-10-05'), new ListHolidayCalendar(['2026-10-05']));
    expect(result.shifted).toBe(true);
    if (result.shifted) expect(result.days).toBe(-3);
  });

  it('keeps the original time of day when it shifts', () => {
    const target = new Date('2026-10-02T09:15:00.000Z');
    const result = shiftForBankHoliday(target, cal);
    expect(result.date.getUTCHours()).toBe(9);
    expect(result.date.getUTCMinutes()).toBe(15);
  });

  it('reports what it did, so the shift is auditable', () => {
    const result = shiftForBankHoliday(ist('2026-10-02'), cal);
    if (result.shifted) expect(result.reason).toContain('bank holiday');
  });

  it('does not throw on an empty calendar', () => {
    expect(() => shiftForBankHoliday(ist('2026-10-06'), new ListHolidayCalendar([]))).not.toThrow();
  });
});
