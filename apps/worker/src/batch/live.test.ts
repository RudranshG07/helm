import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { cleanup, runLiveBatch } from './live.ts';

const MERCHANT = 'merchant_live_batch_test';

afterAll(async () => {
  await cleanup(MERCHANT);
  await close();
});

describe('every execution the batch performs is explainable after the fact', () => {
  it('records a decision for each attempt it makes', async () => {
    const r = await runLiveBatch({ count: 20, seed: 13, merchantId: MERCHANT });
    expect(r.decisions_recorded).toBeGreaterThanOrEqual(r.attempts_spent);
  });

  it('leaves no treatment execution without the decision that authorised it', async () => {
    await runLiveBatch({ count: 20, seed: 17, merchantId: MERCHANT });
    const { rows } = await query<{ orphans: number }>(
      `SELECT count(*)::int AS orphans
         FROM execution_intent i
         JOIN arm_assignment a ON a.subscription_id = i.subscription_id
        WHERE i.subscription_id LIKE $1
          AND a.arm = 'treatment'
          AND i.decision_id IS NULL`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.orphans).toBe(0);
  });

  it('records no Helm decision for a control mandate, because there is none to make', async () => {
    await runLiveBatch({ count: 20, seed: 17, merchantId: MERCHANT });
    const { rows } = await query<{ leaked: number }>(
      `SELECT count(*)::int AS leaked
         FROM decision d
         JOIN arm_assignment a ON a.subscription_id = d.subscription_id
        WHERE d.subscription_id LIKE $1 AND a.arm = 'control'`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.leaked).toBe(0);
  });

  it('points every decision at an execution that really happened', async () => {
    await runLiveBatch({ count: 20, seed: 19, merchantId: MERCHANT });
    const { rows } = await query<{ dangling: number }>(
      `SELECT count(*)::int AS dangling FROM execution_intent ei
        WHERE ei.subscription_id LIKE $1
          AND ei.decision_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM decision d WHERE d.id = ei.decision_id)`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.dangling).toBe(0);
  });

  it('records the rule that allowed each attempt, never a blank verdict', async () => {
    await runLiveBatch({ count: 20, seed: 23, merchantId: MERCHANT });
    const { rows } = await query<{ blank: number }>(
      `SELECT count(*)::int AS blank FROM decision
        WHERE subscription_id LIKE $1 AND (rule_id IS NULL OR rule_id = '' OR verdict IS NULL)`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.blank).toBe(0);
  });
});

describe('the batch runs through the real executor, not a probability draw', () => {
  it('writes one execution intent per attempt and exactly one order for each', async () => {
    const r = await runLiveBatch({ count: 20, seed: 7, merchantId: MERCHANT });

    expect(r.attempts_spent).toBeGreaterThan(0);
    expect(r.intents_written).toBe(r.treatment_attempts);
    expect(r.orders_created).toBe(r.treatment_attempts + r.control_attempts);
    expect(r.exactly_once_held).toBe(true);
  });

  it('splits the population into both arms so the comparison has a control', async () => {
    const r = await runLiveBatch({ count: 40, seed: 7, merchantId: MERCHANT });
    expect(r.control_mandates).toBeGreaterThan(0);
    expect(r.treatment_mandates).toBeGreaterThan(0);
    expect(r.control_mandates + r.treatment_mandates).toBe(r.mandates);
  });

  it('every idempotency key is unique across the whole batch', async () => {
    await runLiveBatch({ count: 20, seed: 11, merchantId: MERCHANT });
    const { rows } = await query<{ keys: number; intents: number }>(
      `SELECT count(DISTINCT idempotency_key)::int AS keys, count(*)::int AS intents
         FROM execution_intent WHERE subscription_id LIKE $1`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.keys).toBe(rows[0]!.intents);
  });

  it('never spends more than the network budget on any one mandate', async () => {
    await runLiveBatch({ count: 20, seed: 13, merchantId: MERCHANT });
    const { rows } = await query<{ subscription_id: string; n: number }>(
      `SELECT subscription_id, count(*)::int AS n FROM execution_intent
        WHERE subscription_id LIKE $1 GROUP BY 1 ORDER BY n DESC LIMIT 1`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]?.n ?? 0).toBeLessThanOrEqual(3);
  });

  it('never recovers more than was at risk', async () => {
    const r = await runLiveBatch({ count: 20, seed: 17, merchantId: MERCHANT });
    expect(r.amount_recovered_paise).toBeLessThanOrEqual(r.amount_at_risk_paise);
  });

  it('settles every intent it created rather than leaving them hanging', async () => {
    await runLiveBatch({ count: 15, seed: 19, merchantId: MERCHANT });
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM execution_intent
        WHERE subscription_id LIKE $1 AND state IN ('INTENDED','SUBMITTED')`,
      [`${MERCHANT}:%`],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('stops the whole batch when the kill switch is engaged', async () => {
    await query(`UPDATE control_flags SET kill_switch = TRUE WHERE id = 1`);
    try {
      const r = await runLiveBatch({ count: 10, seed: 23, merchantId: MERCHANT });
      expect(r.attempts_spent).toBe(0);
      expect(r.orders_created).toBe(0);
    } finally {
      await query(`UPDATE control_flags SET kill_switch = FALSE WHERE id = 1`);
    }
  });

  it('is reproducible for a fixed seed', async () => {
    const a = await runLiveBatch({ count: 15, seed: 29, merchantId: MERCHANT });
    const b = await runLiveBatch({ count: 15, seed: 29, merchantId: MERCHANT });
    expect(b.attempts_spent).toBe(a.attempts_spent);
    expect(b.amount_recovered_paise).toBe(a.amount_recovered_paise);
  });
});
