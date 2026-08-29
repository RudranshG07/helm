import { ListHolidayCalendar, shiftForBankHoliday } from '@mandate/core';
import type { HolidayCalendar, HolidayShift } from '@mandate/core';
import { query } from '@mandate/db';
import { log } from './log.ts';

let cached: { calendar: HolidayCalendar; loadedAt: number } | null = null;
const TTL_MS = 6 * 3600 * 1000;

export async function loadCalendar(region = 'IN'): Promise<HolidayCalendar> {
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.calendar;

  const { rows } = await query<{ holiday_date: string }>(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date
       FROM bank_holiday WHERE region = $1 ORDER BY holiday_date`,
    [region],
  );

  const calendar = new ListHolidayCalendar(rows.map((r) => r.holiday_date));
  cached = { calendar, loadedAt: Date.now() };
  return calendar;
}

export function resetCalendarCache(): void {
  cached = null;
}

export interface ShiftDecision {
  at: Date;
  shifted: boolean;
  reason: string | null;
  covered: boolean;
}

export async function shiftIfNeeded(
  at: Date,
  method: string,
  region = 'IN',
): Promise<ShiftDecision> {
  if (method !== 'emandate') {
    return { at, shifted: false, reason: null, covered: true };
  }

  const calendar = await loadCalendar(region);
  const year = new Date(at.getTime() + 330 * 60_000).getUTCFullYear();

  if (!calendar.coversYear(year)) {
    log.warn('holidays.year_not_covered', { year, region });
    return {
      at,
      shifted: false,
      reason: `No bank holiday data loaded for ${year}, so no shift was applied`,
      covered: false,
    };
  }

  const shift: HolidayShift = shiftForBankHoliday(at, calendar);
  if (!shift.shifted) return { at, shifted: false, reason: null, covered: true };

  log.info('holidays.shifted', {
    from: shift.from.toISOString(),
    to: shift.date.toISOString(),
    days: shift.days,
    reason: shift.reason,
  });

  return { at: shift.date, shifted: true, reason: shift.reason, covered: true };
}
