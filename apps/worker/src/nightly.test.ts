import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { isSweepDue, nightlySweep } from './nightly.ts';

const MERCHANT = 'merchant_nightly';
const NOW = new Date('2026-09-01T02:00:00Z');

async function reset() {
  await query(`DELETE FROM mandate_health WHERE subscription_id LIKE $1`, [`${MERCHANT}:%`]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id LIKE $1`, [`${MERCHANT}:%`]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [MERCHANT]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [MERCHANT]);
}

async function mandate(id: string, over: { expiry?: Date | null; status?: string; amount?: number } = {}) {
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, mandate_expiry_at)
     VALUES ($1,$2,$3,$3,'upi_autopay',$4,$5,$6,$7)`,
    [
      `${MERCHANT}:${id}`, MERCHANT, id, over.amount ?? 49900,
      over.status ?? 'active',
      new Date('2026-09-01T00:00:00Z'),
      over.expiry === undefined ? new Date('2027-09-01T00:00:00Z') : over.expiry,
    ],
  );
}

async function band(id: string): Promise<string | null> {
  const { rows } = await query<{ risk_band: string }>(
    `SELECT risk_band FROM mandate_health WHERE subscription_id = $1
      ORDER BY scored_at DESC, id DESC LIMIT 1`,
    [`${MERCHANT}:${id}`],
  );
  return rows[0]?.risk_band ?? null;
}

afterAll(async () => {
  await reset();
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
  await close();
});

describe('it scores mandates that have not failed yet', () => {
  it('flags a mandate approaching expiry before any charge has failed', async () => {
    await reset();
    await mandate('sub_expiring', { expiry: new Date('2026-09-05T00:00:00Z') });

    const result = await nightlySweep(NOW, { merchantId: MERCHANT });

    expect(await band('sub_expiring')).toBe('critical');
    expect(result.before_any_failure).toBeGreaterThan(0);
  });

  it('leaves a healthy mandate healthy', async () => {
    await reset();
    await mandate('sub_fine');
    await nightlySweep(NOW, { merchantId: MERCHANT });
    expect(await band('sub_fine')).toBe('healthy');
  });

  it('reports how many crossed into at risk on this sweep', async () => {
    await reset();
    await mandate('sub_a', { expiry: new Date('2026-09-20T00:00:00Z') });
    const result = await nightlySweep(NOW, { merchantId: MERCHANT });
    expect(result.newly_at_risk + result.newly_critical).toBeGreaterThan(0);
  });

  it('does not sweep halted or cancelled mandates', async () => {
    await reset();
    await mandate('sub_halted', { status: 'halted' });
    await mandate('sub_cancelled', { status: 'cancelled' });
    const result = await nightlySweep(NOW, { merchantId: MERCHANT });
    expect(result.examined).toBe(0);
  });

  it('writes a health row for every mandate it scores', async () => {
    await reset();
    await mandate('sub_1');
    await mandate('sub_2');
    const result = await nightlySweep(NOW, { merchantId: MERCHANT });
    expect(result.scored).toBe(2);
  });

  it('records the score breakdown, not just the number', async () => {
    await reset();
    await mandate('sub_c', { expiry: new Date('2026-09-03T00:00:00Z') });
    await nightlySweep(NOW, { merchantId: MERCHANT });
    const { rows } = await query<{ contributions: Record<string, number> }>(
      `SELECT contributions FROM mandate_health WHERE subscription_id = $1`,
      [`${MERCHANT}:sub_c`],
    );
    expect(Object.keys(rows[0]!.contributions).length).toBeGreaterThan(2);
  });
});

describe('it does not rescore the same mandate repeatedly', () => {
  it('skips a mandate scored within the interval', async () => {
    await reset();
    await mandate('sub_recent');
    await nightlySweep(NOW, { merchantId: MERCHANT });
    const second = await nightlySweep(new Date(NOW.getTime() + 60_000), { merchantId: MERCHANT });
    expect(second.scored).toBe(0);
    expect(second.examined).toBe(1);
  });

  it('scores it again once the interval has passed', async () => {
    await reset();
    await mandate('sub_later');
    await nightlySweep(NOW, { merchantId: MERCHANT });
    const second = await nightlySweep(new Date(NOW.getTime() + 25 * 3600 * 1000), { merchantId: MERCHANT });
    expect(second.scored).toBe(1);
  });

  it('respects the mandate limit rather than sweeping everything at once', async () => {
    await reset();
    for (let i = 0; i < 5; i += 1) await mandate(`sub_lim_${i}`);
    expect((await nightlySweep(NOW, { merchantId: MERCHANT, limit: 2 })).examined).toBe(2);
  });
});

describe('sweep scheduling', () => {
  it('is due when it has never run', () => {
    expect(isSweepDue(null, NOW, 3600_000)).toBe(true);
  });
  it('is not due inside the interval', () => {
    expect(isSweepDue(new Date(NOW.getTime() - 1000), NOW, 3600_000)).toBe(false);
  });
  it('is due exactly at the interval', () => {
    expect(isSweepDue(new Date(NOW.getTime() - 3600_000), NOW, 3600_000)).toBe(true);
  });
});
