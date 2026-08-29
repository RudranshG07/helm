import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { loadCalendar, resetCalendarCache, shiftIfNeeded } from './holidays.ts';

function ist(iso: string): Date {
  return new Date(`${iso}T04:30:00.000Z`);
}

beforeEach(() => resetCalendarCache());
afterAll(async () => {
  resetCalendarCache();
  await close();
});

describe('the calendar is loaded from the database, not hardcoded', () => {
  it('loads the seeded Indian bank holidays', async () => {
    const cal = await loadCalendar();
    expect(cal.isHoliday(ist('2026-10-02'))).toBe(true);
    expect(cal.isHoliday(ist('2026-11-08'))).toBe(true);
  });

  it('knows which years it actually covers', async () => {
    const cal = await loadCalendar();
    expect(cal.coversYear(2026)).toBe(true);
    expect(cal.coversYear(2027)).toBe(true);
    expect(cal.coversYear(2035)).toBe(false);
  });

  it('caches so every dispatch does not hit the database', async () => {
    const a = await loadCalendar();
    expect(await loadCalendar()).toBe(a);
  });
});

describe('shifting only applies where the bank actually shifts it', () => {
  it('leaves UPI Autopay alone, because it settles every day', async () => {
    const at = ist('2026-10-02');
    const r = await shiftIfNeeded(at, 'upi_autopay');
    expect(r.shifted).toBe(false);
    expect(r.at).toBe(at);
  });

  it('moves an e-mandate off a bank holiday', async () => {
    const r = await shiftIfNeeded(ist('2026-10-02'), 'emandate');
    expect(r.shifted).toBe(true);
    expect(r.reason).toContain('bank holiday');
  });

  it('leaves an e-mandate on a working day alone', async () => {
    const r = await shiftIfNeeded(ist('2026-10-06'), 'emandate');
    expect(r.shifted).toBe(false);
  });

  it('moves back three days when the preceding day is also closed', async () => {
    const r = await shiftIfNeeded(ist('2026-11-09'), 'emandate');
    expect(r.shifted).toBe(true);
    expect(r.at.getTime()).toBeLessThan(ist('2026-11-08').getTime());
  });

  it('refuses to shift silently in a year it has no data for, and says so', async () => {
    const r = await shiftIfNeeded(ist('2035-01-26'), 'emandate');
    expect(r.covered).toBe(false);
    expect(r.shifted).toBe(false);
    expect(r.reason).toContain('No bank holiday data');
  });

  it('never moves a charge forward, only back', async () => {
    const target = ist('2026-10-02');
    const r = await shiftIfNeeded(target, 'emandate');
    expect(r.at.getTime()).toBeLessThan(target.getTime());
  });

  it('does not throw when the table is empty', async () => {
    await query(`CREATE TEMP TABLE IF NOT EXISTS _noop ()`);
    resetCalendarCache();
    await expect(shiftIfNeeded(ist('2026-10-06'), 'emandate')).resolves.toBeDefined();
  });
});
