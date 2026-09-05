import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { buildCalibration } from './calibration.ts';

const M = 'merchant_calibration_test';
const SUB = `${M}:sub`;

async function record(p: number, succeeded: boolean, n: number) {
  for (let i = 0; i < n; i += 1) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO decision (subscription_id, cycle, proposed_action, proposed_by, verdict,
                             rule_id, predicted_p)
       VALUES ($1, now(), 'RETRY_SCHEDULED', 'allocator', 'ALLOW', 'R-OK', $2)
       RETURNING id::text AS id`,
      [SUB, p],
    );
    await query(
      `INSERT INTO execution_intent (idempotency_key, subscription_id, cycle, attempt_number,
                                     decision_id, amount_paise, scheduled_for, state)
       VALUES ($1, $2, now(), $3, $4::bigint, 10000, now(), $5)`,
      [`cal_${rows[0]!.id}`, SUB, i + 1, rows[0]!.id,
       succeeded ? 'SETTLED_SUCCESS' : 'SETTLED_FAILED'],
    );
  }
}

beforeAll(async () => {
  await query(`DELETE FROM execution_intent WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM decision WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(
    `INSERT INTO merchant (id, name, mode, synthetic) VALUES ($1, $1, 'test', TRUE)`, [M],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
                               amount_paise, status)
     VALUES ($1, $2, $1, 'someone', 'upi_autopay', 10000, 'active')`,
    [SUB, M],
  );
});

afterAll(async () => {
  await query(`DELETE FROM execution_intent WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM decision WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await close();
});

describe('the model is scored against what actually happened', () => {
  it('reports nothing measured rather than a flattering zero', async () => {
    const before = await buildCalibration();
    expect(before.scored).toBe(0);
    expect(before.brier).toBeNull();
    expect(before.verdict).toContain('unmeasured');
  });

  it('scores a prediction against its own attempt, not the cycle', async () => {
    await record(0.9, true, 9);
    await record(0.9, false, 1);

    const c = await buildCalibration();
    expect(c.scored).toBe(10);
    expect(c.observed_rate).toBeCloseTo(0.9, 5);
    expect(c.predicted_mean).toBeCloseTo(0.9, 5);
    expect(c.brier).toBeCloseTo(0.09, 5);
  });

  it('places each prediction in the band it belongs to', async () => {
    const c = await buildCalibration();
    const band = c.bands.find((b) => b.low === 0.75);
    expect(band).toBeDefined();
    expect(band!.n).toBe(10);
  });

  it('says so when a model does not beat the base rate', async () => {
    const c = await buildCalibration();
    expect(c.skill).not.toBeNull();
    expect(c.verdict).toMatch(/base rate/);
  });

  it('counts real-account observations separately from synthetic ones', async () => {
    const c = await buildCalibration();
    expect(c.real_account_scored).toBe(0);
    expect(c.verdict).toContain('none on a real account');
  });
});
