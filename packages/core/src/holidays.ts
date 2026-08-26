export interface HolidayCalendar {
  isHoliday(date: Date): boolean;
  coversYear(year: number): boolean;
}

const DAY_MS = 86_400_000;

export class ListHolidayCalendar implements HolidayCalendar {
  private readonly dates: Set<string>;
  private readonly years: Set<number>;

  constructor(isoDates: string[]) {
    this.dates = new Set(isoDates);
    this.years = new Set(isoDates.map((d) => Number(d.slice(0, 4))));
  }

  isHoliday(date: Date): boolean {
    return this.dates.has(istDateKey(date)) || isWeekendHoliday(date);
  }

  coversYear(year: number): boolean {
    return this.years.has(year);
  }
}

export function istDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + 330 * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function isWeekendHoliday(date: Date): boolean {
  const shifted = new Date(date.getTime() + 330 * 60_000);
  const day = shifted.getUTCDay();
  if (day === 0) return true;
  if (day !== 6) return false;
  const dayOfMonth = shifted.getUTCDate();
  const nth = Math.floor((dayOfMonth - 1) / 7) + 1;
  return nth === 2 || nth === 4;
}

export type HolidayShift =
  | { shifted: false; date: Date }
  | { shifted: true; date: Date; from: Date; days: number; reason: string };

export function shiftForBankHoliday(target: Date, calendar: HolidayCalendar): HolidayShift {
  if (!calendar.isHoliday(target)) {
    return { shifted: false, date: target };
  }

  const minusOne = new Date(target.getTime() - DAY_MS);
  if (!calendar.isHoliday(minusOne)) {
    return { shifted: true, date: minusOne, from: target, days: -1, reason: 'charge day is a bank holiday' };
  }

  const minusThree = new Date(target.getTime() - 3 * DAY_MS);
  return {
    shifted: true,
    date: minusThree,
    from: target,
    days: -3,
    reason: 'charge day and the preceding day are both bank holidays',
  };
}
