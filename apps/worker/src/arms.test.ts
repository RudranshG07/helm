import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { armFor, armTotals, assignArm } from './arms.ts';

const M = 'merchant_arms_test';
const sub = (n: string) => `${M}:${n}`;

async function reset() {
  await query(`DELETE FROM arm_assignment a USING subscription s
                WHERE a.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM payment_attempt pa USING subscription s
                WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [M]);
}

async function mandate(n: string, amount = 100000) {
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start)
     VALUES ($1,$2,$1,$1,'upi_autopay',$3,'active',now())`,
    [sub(n), M, amount],
  );
}

async function attempt(n: string, status: string, by: string) {
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       initiated_by, source)
     VALUES ($1, date_trunc('month', now()), now(), $2,
             (SELECT amount_paise FROM subscription WHERE id = $1), $3,
             CASE WHEN $3 = 'mandate_rescue' THEN 'executor' ELSE 'webhook' END)`,
    [sub(n), status, by],
  );
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('arm assignment is stable and recorded, not decided on the fly', () => {
  it('records the arm the first time it is asked', async () => {
    await mandate('a');
    const arm = await assignArm(sub('a'));
    const { rows } = await query<{ arm: string }>(
      `SELECT arm FROM arm_assignment WHERE subscription_id = $1`, [sub('a')]);
    expect(rows[0]!.arm).toBe(arm);
  });

  it('returns the same arm on every later call', async () => {
    await mandate('b');
    const first = await assignArm(sub('b'));
    for (let i = 0; i < 5; i += 1) {
      expect(await assignArm(sub('b'))).toBe(first);
    }
  });

  it('never changes an arm once recorded, even if the salt changes', async () => {
    await mandate('c');
    const first = await assignArm(sub('c'), 'salt-one');
    expect(await assignArm(sub('c'), 'salt-two')).toBe(first);
  });

  it('is deterministic from the identifier alone', () => {
    expect(armFor('sub_x', 's')).toBe(armFor('sub_x', 's'));
  });

  it('splits a population into both arms rather than collapsing to one', () => {
    const arms = Array.from({ length: 400 }, (_, i) => armFor(`sub_${i}`, 'helm'));
    const treatment = arms.filter((a) => a === 'treatment').length;
    expect(treatment).toBeGreaterThan(120);
    expect(treatment).toBeLessThan(280);
  });
});

describe('per-arm totals separate our attempts from Razorpay defaults', () => {
  it('attributes a recovery attempt we made to us, not to Razorpay', async () => {
    await mandate('d');
    await assignArm(sub('d'));
    await attempt('d', 'failed', 'razorpay_default');
    await attempt('d', 'failed', 'razorpay_default');
    await attempt('d', 'captured', 'mandate_rescue');

    const totals = await armTotals(M);
    const row = totals.find((t) => t.attempts_by_us > 0);
    expect(row?.attempts_by_us).toBe(1);
    expect(row?.attempts_by_default).toBe(1);
  });

  it('excludes the failure that started the cycle from the attempt denominator', async () => {
    await mandate('d2');
    await assignArm(sub('d2'));
    await attempt('d2', 'failed', 'razorpay_default');

    const totals = await armTotals(M);
    const row = totals[0]!;
    expect(row.attempts_by_us + row.attempts_by_default).toBe(0);
  });

  it('counts a cycle that captured as recovered', async () => {
    await mandate('e', 50000);
    await assignArm(sub('e'));
    await attempt('e', 'failed', 'razorpay_default');
    await attempt('e', 'captured', 'mandate_rescue');

    const totals = await armTotals(M);
    const row = totals[0]!;
    expect(row.amount_recovered_paise).toBe(50000);
    expect(row.mandates_halted).toBe(0);
  });

  it('counts a cycle that never captured as halted', async () => {
    await mandate('f', 70000);
    await assignArm(sub('f'));
    await attempt('f', 'failed', 'razorpay_default');

    const totals = await armTotals(M);
    expect(totals[0]!.mandates_halted).toBe(1);
    expect(totals[0]!.amount_recovered_paise).toBe(0);
  });

  it('reports the denominator alongside the recovery', async () => {
    await mandate('g', 30000);
    await assignArm(sub('g'));
    await attempt('g', 'failed', 'razorpay_default');

    const totals = await armTotals(M);
    expect(totals[0]!.amount_at_risk_paise).toBe(30000);
  });

  it('ignores cycles that never failed', async () => {
    await mandate('h');
    await assignArm(sub('h'));
    await attempt('h', 'captured', 'razorpay_default');

    const totals = await armTotals(M);
    expect(totals).toHaveLength(0);
  });
});
