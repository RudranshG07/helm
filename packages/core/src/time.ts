export const IST_OFFSET_MIN = 330;

const MIN = 60_000;
const HOUR = 60 * MIN;

export const PDN_MIN_LEAD_MS = 24 * HOUR;

export const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [10 * 60, 13 * 60],
  [17 * 60, 21 * 60 + 30],
];

export const PDN_CUTOFF_MINUTE = 23 * 60 + 50;

export function toIstParts(d: Date) {
  const s = new Date(d.getTime() + IST_OFFSET_MIN * MIN);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth(),
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    minuteOfDay: s.getUTCHours() * 60 + s.getUTCMinutes(),
    epochDay: Math.floor(s.getTime() / 86_400_000),
  };
}

export function fromIst(year: number, month: number, day: number, minuteOfDay: number): Date {
  return new Date(Date.UTC(year, month, day, 0, minuteOfDay - IST_OFFSET_MIN, 0, 0));
}

export function isPeak(d: Date): boolean {
  const m = toIstParts(d).minuteOfDay;
  return PEAK_WINDOWS.some(([start, end]) => m >= start && m < end);
}

export function snapOutOfPeak(d: Date): Date {
  const p = toIstParts(d);
  for (const [start, end] of PEAK_WINDOWS) {
    if (p.minuteOfDay >= start && p.minuteOfDay < end) {
      return fromIst(p.year, p.month, p.day, end);
    }
  }
  return d;
}

export function isNextIstDay(from: Date, target: Date): boolean {
  return toIstParts(target).epochDay === toIstParts(from).epochDay + 1;
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}
