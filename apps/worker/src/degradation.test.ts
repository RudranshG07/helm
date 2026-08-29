import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { isDegraded, leadTimes, recordRazorpayDowntime, rollupDegradation } from './degradation.ts';
import { ingestBatch } from './ingest.ts';

const MERCHANT = 'merchant_degradation_test';
const SUB = `${MERCHANT}:sub_deg`;
const CYCLE = new Date('2026-09-01T00:00:00.000Z');

async function reset() {
  await query(`DELETE FROM raw_event`);
  await query(`DELETE FROM degradation_signal`);
  await query(`DELETE FROM mandate_health WHERE subscription_id = $1`, [SUB]);
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

    expect(await rollupDegradation(MERCHANT)).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('stays quiet when the recent rate matches the baseline', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 45, 'HDFC', 0.5);

    expect(await rollupDegradation(MERCHANT)).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('opens a signal on a real drop with volume behind it', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);

    expect(await rollupDegradation(MERCHANT)).toBe(1);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);
  });

  it('does not open a second signal while one is already open', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);

    await rollupDegradation(MERCHANT);
    expect(await rollupDegradation(MERCHANT)).toBe(0);

    const { rows } = await query(`SELECT id FROM degradation_signal WHERE source = 'internal_rollup'`);
    expect(rows).toHaveLength(1);
  });

  it('resolves the signal once the rate recovers', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await rollupDegradation(MERCHANT);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);

    await query(`UPDATE payment_attempt SET status = 'captured'
                  WHERE subscription_id = $1 AND attempted_at > now() - interval '2 hours'`, [SUB]);
    await rollupDegradation(MERCHANT);

    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('does not flag a healthy issuer because a different one is degraded', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    await attempts(200, 180, 'ICICI', 48);
    await attempts(50, 46, 'ICICI', 0.5);

    await rollupDegradation(MERCHANT);

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

    expect(await rollupDegradation(MERCHANT)).toBe(0);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('includes a merchant that has opted in', async () => {
    await reset();
    await attempts(200, 180, 'HDFC', 48);
    await attempts(50, 5, 'HDFC', 0.5);
    expect(await rollupDegradation(MERCHANT)).toBe(1);
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
    await rollupDegradation(MERCHANT);

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
    await rollupDegradation(MERCHANT);

    const lead = await leadTimes();
    expect(lead).toHaveLength(1);
    expect(lead[0]!.lead_seconds).toBeLessThan(0);
  });
});

describe('downtime webhooks reach the degradation signal', () => {
  async function ingestDowntime(eventType: string, entity: Record<string, unknown>) {
    await query(
      `INSERT INTO raw_event (rzp_event_id, event_type, payload, signature_ok)
       VALUES ($1, $2, $3, TRUE)`,
      [
        `evt_${eventType}_${Math.random()}`,
        eventType,
        { event: eventType, payload: { payment: { downtime: { entity } } } },
      ],
    );
    await ingestBatch();
  }

  it('opens a signal when the gateway reports downtime started', async () => {
    await reset();
    await ingestDowntime('payment.downtime.started', {
      method: 'upi', severity: 'high',
      begin: Math.floor(Date.now() / 1000),
      instrument: { issuer: 'HDFC' },
    });
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);
  });

  it('maps the gateway method name onto ours', async () => {
    await reset();
    await ingestDowntime('payment.downtime.started', {
      method: 'upi', severity: 'high', begin: Math.floor(Date.now() / 1000),
      instrument: { issuer: 'SBI' },
    });
    const { rows } = await query<{ method: string }>(
      `SELECT method FROM degradation_signal WHERE source = 'razorpay_downtime'`,
    );
    expect(rows[0]!.method).toBe('upi_autopay');
  });

  it('closes the signal when the gateway reports it resolved', async () => {
    await reset();
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);

    const begin = Math.floor(Date.now() / 1000);
    await ingestDowntime('payment.downtime.started', { method: 'upi', severity: 'high', begin, instrument: { issuer: 'HDFC' } });
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(true);

    await ingestDowntime('payment.downtime.resolved', { method: 'upi', begin, instrument: { issuer: 'HDFC' } });

    const { rows } = await query<{ source: string; resolved: boolean }>(
      `SELECT source, resolved_at IS NOT NULL AS resolved FROM degradation_signal ORDER BY id`,
    );
    expect(rows.every((r) => r.resolved), `open signals remain: ${JSON.stringify(rows)}`).toBe(true);
    expect(await isDegraded('HDFC', 'upi_autopay')).toBe(false);
  });

  it('does not throw on a downtime payload it does not recognise', async () => {
    await reset();
    await expect(ingestDowntime('payment.downtime.started', {})).resolves.not.toThrow();
    expect(await isDegraded(null, 'upi_autopay')).toBe(false);
  });

  it('marks the event processed so it is not retried forever', async () => {
    await reset();
    await ingestDowntime('payment.downtime.started', {
      method: 'upi', severity: 'low', begin: Math.floor(Date.now() / 1000), instrument: { issuer: 'AXIS' },
    });
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM raw_event WHERE processed_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
