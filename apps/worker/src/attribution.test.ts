import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { execute } from './executor.ts';
import { StubGateway } from './gateway.stub.ts';

const M = 'merchant_attribution_test';
const S = `${M}:sub_attr`;
const CYCLE = new Date('2026-08-20T00:00:00.000Z');

async function reset() {
  await query(`DELETE FROM mandate_health mh USING subscription s
                WHERE mh.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM decision d USING subscription s
                WHERE d.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM arm_assignment a USING subscription s
                WHERE a.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM execution_intent WHERE subscription_id LIKE $1`, [`${M}:%`]);
  await query(`DELETE FROM payment_attempt pa USING subscription s
                WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
  await query(`INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',TRUE)`, [M]);
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, current_end)
     VALUES ($1,$2,$1,$1,'upi_autopay',49900,'active',$3,$4)`,
    [S, M, CYCLE, new Date(CYCLE.getTime() + 30 * 86_400_000)],
  );
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       error_reason, bucket, issuer, initiated_by, source)
     VALUES ($1,$2,$2,'failed',49900,'insufficient_funds','SOFT_LIQUIDITY','HDFC','razorpay_default','webhook')`,
    [S, CYCLE],
  );
}

const req = (n: number) => ({
  decision_id: null,
  subscription_id: S,
  rzp_subscription_id: S,
  cycle: CYCLE,
  attempt_number: n,
  amount_paise: 49900,
  scheduled_for: new Date(CYCLE.getTime() + n * 86_400_000),
});

async function attempts() {
  const { rows } = await query<{ status: string; bucket: string | null; initiated_by: string; source: string }>(
    `SELECT status, bucket, initiated_by, source FROM payment_attempt
      WHERE subscription_id = $1 ORDER BY attempted_at, id`, [S]);
  return rows;
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('an attempt we make is recorded as ours, so measurement is not corrupted', () => {
  it('writes a payment attempt attributed to us', async () => {
    await execute(req(2), { gateway: new StubGateway(), dryRun: false });
    const rows = await attempts();
    const ours = rows.filter((r) => r.initiated_by === 'mandate_rescue');
    expect(ours).toHaveLength(1);
    expect(ours[0]!.source).toBe('executor');
  });

  it('can be told to record on behalf of the default schedule, for a control arm', async () => {
    await execute(req(2), {
      gateway: new StubGateway(), dryRun: false, initiatedBy: 'razorpay_default',
    });
    const rows = await attempts();
    expect(rows.every((r) => r.initiated_by === 'razorpay_default')).toBe(true);
  });

  it('writes nothing extra on a dry run', async () => {
    await execute(req(2), { gateway: new StubGateway(), dryRun: true });
    expect(await attempts()).toHaveLength(1);
  });
});

describe('a recovered attempt carries the decline it recovered, not a fresh classification', () => {
  it('inherits the bucket of the failure it was recovering', async () => {
    await execute(req(2), { gateway: new StubGateway({ paymentStatus: 'captured' }), dryRun: false });
    const rows = await attempts();
    const captured = rows.find((r) => r.status === 'captured');
    expect(captured?.bucket).toBe('SOFT_LIQUIDITY');
  });

  it('never files a success under UNKNOWN, which would teach the model that bucket never recovers', async () => {
    await execute(req(2), { gateway: new StubGateway({ paymentStatus: 'captured' }), dryRun: false });
    const rows = await attempts();
    expect(rows.find((r) => r.status === 'captured')?.bucket).not.toBe('UNKNOWN');
  });

  it('still classifies a failed attempt from its own error, not the earlier one', async () => {
    await execute(req(2), { gateway: new StubGateway({ paymentStatus: 'failed' }), dryRun: false });
    const rows = await attempts();
    const failed = rows.filter((r) => r.source === 'executor');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe('failed');
  });

  it('leaves the success model a bucket with both wins and losses in it', async () => {
    await execute(req(2), { gateway: new StubGateway({ paymentStatus: 'captured' }), dryRun: false });
    const { rows } = await query<{ captured: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status='captured')::int AS captured,
              count(*) FILTER (WHERE status='failed')::int AS failed
         FROM payment_attempt WHERE subscription_id = $1 AND bucket = 'SOFT_LIQUIDITY'`, [S]);
    expect(rows[0]!.captured).toBeGreaterThan(0);
    expect(rows[0]!.failed).toBeGreaterThan(0);
  });
});
