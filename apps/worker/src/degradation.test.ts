import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { isDegraded, leadTimes, recordRazorpayDowntime, rollupDegradation } from './degradation.ts';

const MERCHANT = 'merchant_degradation_test';
const SUB = `${MERCHANT}:sub_deg`;
const CYCLE = new Date('2026-09-01T00:00:00.000Z');

async function reset() {
  await query(`DELETE FROM degradation_signal`);
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE id = $1`, [SUB]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
  await query(
    `INSERT INTO merchant (id, name, mode, cross_merchant_signals) VALUES ($1,$1,'test',TRUE)`,
    [MERCHANT],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start)
     VALUES ($1,$2,'sub_deg','cust_deg','upi_autopay',49900,'active',$3)`,
    [SUB, MERCHANT, CYCLE],
  );
}

async function attempts(count: number, captured: number, issuer: string, hoursAgo: number) {
  for (let i = 0; i < count; i += 1) {
    await query(
      `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
         issuer, initiated_by)
       VALUES ($1,$2, now() - ($3::float8 * interval '1 hour'), $4, 49900, $5, 'razorpay_default')`,
      [SUB, CYCLE, hoursAgo + i * 0.001, i < captured ? 'captured' : 'failed', issuer],
    );
  }
}

afterAll(async () => {
  await query(`DELETE FROM degradation_signal`);
  await close();
});

describe('the rollup only fires on evidence', () => {
  it('stays quiet when there is not enough recent volume', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(3, 0, 'HDFC', 0.5);

    expect(await rollupDegradation()).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('stays quiet when the recent rate matches the baseline', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 45, 'HDFC', 0.5);

    expect(await rollupDegradation()).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('opens a signal on a real drop with volume behind it', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);

    expect(await rollupDegradation()).toBe(1);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);
  });

  it('does not open a second signal while one is already open', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);

    await rollupDegradation();
    expect(await rollupDegradation()).toBe(0);

    const { rows } = await query(`SELECT id FROM degradation_signal WHERE source = 'internal_rollup'`);
    expect(rows).toHaveLength(1);
  });

  it('resolves the signal once the rate recovers', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await rollupDegradation();
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);

    await query(`UPDATE payment_attempt SET status = 'captured'
                  WHERE subscription_id = $1 AND attempted_at > now() - interval '2 hours'`, [SUB]);
    await rollupDegradation();

    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('does not flag a healthy issuer because a different one is degraded', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await attempts(200, 180, 'ICICI', 48);
    await attempts(50, 46, 'ICICI', 0.5);

    await rollupDegradation();

    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);
    expect(await isDegraded('ICICI', 'upi_autopay')).toBe(false);
  });
});

describe('pooling is opt-in per merchant', () => {
  it('excludes a merchant that has not opted into cross-merchant signals', async () => {
    await reset();
    await query(`UPDATE merchant SET cross_merchant_signals = FALSE WHERE id = $1`, [MERCHANT]);
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);

    expect(await rollupDegradation()).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('includes a merchant that has opted in', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    expect(await rollupDegradation()).toBe(1);
  });
});

describe('the two signals are stored side by side', () => {
  it('records a downtime reported by the gateway', async () => {
    await reset();
    await recordRazorpayDowntime({
      issuer: 'HDFC', method: 'upi_autopay', severity: 'high',
      started_at: new Date(), resolved: false,
    });
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);
  });

  it('does not duplicate an already-open gateway downtime', async () => {
    await reset();
    const event = { issuer: 'HDFC', method: 'upi_autopay', severity: 'high', started_at: new Date(), resolved: false };
    await recordRazorpayDowntime(event);
    await recordRazorpayDowntime(event);

    const { rows } = await query(`SELECT id FROM degradation_signal WHERE source = 'razorpay_downtime'`);
    expect(rows).toHaveLength(1);
  });

  it('resolves a gateway downtime when it clears', async () => {
    await reset();
    await recordRazorpayDowntime({ issuer: 'HDFC', method: 'upi_autopay', severity: 'high', started_at: new Date(), resolved: false });
    await recordRazorpayDowntime({ issuer: 'HDFC', method: 'upi_autopay', severity: null, started_at: new Date(), resolved: true });
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('measures how far ahead of the gateway our own detector fired', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await rollupDegradation();

    await recordRazorpayDowntime({
      issuer: 'HDFC', method: 'upi_autopay', severity: 'high',
      started_at: new Date(Date.now() + 30 * 60_000), resolved: false,
    });

    const lead = await leadTimes();
    expect(lead).toHaveLength(1);
    expect(lead[0]!.lead_seconds).toBeGreaterThan(0);
  });

  it('reports a negative lead when the gateway saw it first, rather than hiding it', async () => {
    await reset();
    await recordRazorpayDowntime({
      issuer: 'HDFC', method: 'upi_autopay', severity: 'high',
      started_at: new Date(Date.now() - 60 * 60_000), resolved: false,
    });
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await rollupDegradation();

    const lead = await leadTimes();
    expect(lead).toHaveLength(1);
    expect(lead[0]!.lead_seconds).toBeLessThan(0);
  });
});
