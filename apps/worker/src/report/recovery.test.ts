import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { buildRecoveryReport } from './recovery.ts';

const MERCHANT = 'merchant_recovery_report_test';
const CYCLE = new Date('2026-08-01T00:00:00.000Z');

async function reset() {
  await query(`DELETE FROM mandate_health mh USING subscription s
                WHERE mh.subscription_id = s.id AND s.merchant_id = $1`, [MERCHANT]);
  await query(`DELETE FROM payment_attempt pa USING subscription s
                WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [MERCHANT]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [MERCHANT]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [MERCHANT]);
}

async function mandate(id: string, amountPaise: number) {
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, current_end)
     VALUES ($1,$2,$1,$1,'upi_autopay',$3,'active',$4,$5)`,
    [`${MERCHANT}:${id}`, MERCHANT, amountPaise, CYCLE, new Date(CYCLE.getTime() + 30 * 86_400_000)],
  );
}

async function attempt(id: string, status: string, bucket: string | null, hoursAgo = 24) {
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       bucket, error_reason, initiated_by)
     VALUES ($1,$2, now() - ($3::float8 * interval '1 hour'), $4,
             (SELECT amount_paise FROM subscription WHERE id = $1), $5, 'insufficient_funds', 'razorpay_default')`,
    [`${MERCHANT}:${id}`, CYCLE, hoursAgo, status, bucket],
  );
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('the report a merchant sees is denominated in money, not counts', () => {
  it('says nothing happened when there is no failure history', async () => {
    const r = await buildRecoveryReport(MERCHANT);
    expect(r.has_history).toBe(false);
    expect(r.money.at_risk_paise).toBe(0);
    expect(r.headline).toContain('No failed mandates');
  });

  it('counts a cycle that failed then captured as recovered, not lost', async () => {
    await mandate('a', 100000);
    await attempt('a', 'failed', 'SOFT_LIQUIDITY', 48);
    await attempt('a', 'captured', null, 24);

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.money.at_risk_paise).toBe(100000);
    expect(r.money.recovered_paise).toBe(100000);
    expect(r.money.lost_paise).toBe(0);
  });

  it('counts a cycle that only ever failed as lost', async () => {
    await mandate('b', 50000);
    await attempt('b', 'failed', 'SOFT_LIQUIDITY');

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.money.lost_paise).toBe(50000);
    expect(r.money.addressable_paise).toBe(50000);
  });

  it('refuses to call a hard decline recoverable', async () => {
    await mandate('c', 70000);
    await attempt('c', 'failed', 'HARD_CUSTOMER');

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.money.hard_paise).toBe(70000);
    expect(r.money.addressable_paise).toBe(0);
  });

  it('refuses to call an unmapped decline recoverable', async () => {
    await mandate('d', 30000);
    await attempt('d', 'failed', 'UNKNOWN');

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.money.unclassified_paise).toBe(30000);
    expect(r.money.addressable_paise).toBe(0);
  });

  it('never claims more is recoverable than was lost', async () => {
    await mandate('e', 40000);
    await attempt('e', 'failed', 'SOFT_LIQUIDITY');
    await mandate('f', 60000);
    await attempt('f', 'failed', 'HARD_INSTRUMENT');
    await mandate('g', 20000);
    await attempt('g', 'failed', 'UNKNOWN');

    const r = await buildRecoveryReport(MERCHANT);
    const parts = r.money.addressable_paise + r.money.hard_paise + r.money.unclassified_paise;
    expect(parts).toBe(r.money.lost_paise);
    expect(r.money.addressable_paise).toBeLessThanOrEqual(r.money.lost_paise);
  });

  it('warns when the sample is too small to trust', async () => {
    await mandate('h', 10000);
    await attempt('h', 'failed', 'SOFT_LIQUIDITY');

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.honesty.sample_too_small).toBe(true);
    expect(r.caveat).toContain('too few');
  });

  it('excludes failures outside the window', async () => {
    await mandate('i', 90000);
    await attempt('i', 'failed', 'SOFT_LIQUIDITY', 24 * 400);

    const r = await buildRecoveryReport(MERCHANT, 180);
    expect(r.money.at_risk_paise).toBe(0);
  });

  it('surfaces the mandates closest to dying, largest first', async () => {
    await mandate('j', 500000);
    await attempt('j', 'failed', 'SOFT_LIQUIDITY');
    await query(
      `INSERT INTO mandate_health (subscription_id, consecutive_failures, attempts_remaining,
         risk_score, risk_band, amount_at_risk_paise)
       VALUES ($1, 2, 1, 0.8, 'critical', 500000)`,
      [`${MERCHANT}:j`],
    );

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.urgent).toHaveLength(1);
    expect(r.urgent[0]!.amount_paise).toBe(500000);
    expect(r.urgent[0]!.attempts_used).toBe(2);
  });

  it('reports a recovery rate a merchant can check against their own books', async () => {
    await mandate('k', 100000);
    await attempt('k', 'failed', 'SOFT_LIQUIDITY', 48);
    await attempt('k', 'captured', null, 24);
    await mandate('l', 100000);
    await attempt('l', 'failed', 'SOFT_LIQUIDITY');

    const r = await buildRecoveryReport(MERCHANT);
    expect(r.money.recovery_rate).toBeCloseTo(0.5, 5);
  });
});
