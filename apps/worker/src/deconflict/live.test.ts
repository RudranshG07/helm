import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { deconflictScheduled } from './live.ts';

const MERCHANTS = ['dc_a', 'dc_b', 'dc_c'] as const;
const NOW = new Date('2026-09-02T06:00:00.000Z');
const AT = new Date('2026-09-04T08:00:00.000Z');

async function reset() {
  await query(`DELETE FROM decision d USING subscription s
                WHERE d.subscription_id = s.id AND s.merchant_id LIKE 'dc\\_%'`);
  await query(`DELETE FROM subscription WHERE merchant_id LIKE 'dc\\_%'`);
  await query(`DELETE FROM merchant WHERE id LIKE 'dc\\_%'`);
  await query(
    `UPDATE decision SET outcome = 'revoked'
      WHERE verdict = 'ALLOW' AND proposed_action = 'RETRY_SCHEDULED'
        AND executed_at IS NULL AND outcome IS NULL AND scheduled_for > now()`);
}

async function seed(merchant: string, customerKey: string, at: Date, consent = true) {
  await query(
    `INSERT INTO merchant (id, name, mode, cross_merchant_signals)
     VALUES ($1,$1,'test',$2) ON CONFLICT (id) DO UPDATE SET cross_merchant_signals = $2`,
    [merchant, consent],
  );
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, customer_key,
       method, amount_paise, status, current_start, current_end)
     VALUES ($1,$2,$1,$1,$3,'upi_autopay',49900,'active',$4,$5)`,
    [`${merchant}:sub`, merchant, customerKey, NOW, new Date(NOW.getTime() + 25 * 86_400_000)],
  );
  const { rows } = await query<{ id: string }>(
    `INSERT INTO decision (subscription_id, cycle, proposed_action, proposed_by, verdict, rule_id,
       scheduled_for, rationale, explanation)
     VALUES ($1,$2,'RETRY_SCHEDULED','allocator','ALLOW','R-OK',$3,'payday','All bounds satisfied.')
     RETURNING id::text AS id`,
    [`${merchant}:sub`, NOW, at],
  );
  return rows[0]!.id;
}

async function times(customerKey: string) {
  const { rows } = await query<{ merchant_id: string; scheduled_for: Date }>(
    `SELECT s.merchant_id, d.scheduled_for FROM decision d
       JOIN subscription s ON s.id = d.subscription_id
      WHERE s.customer_key = $1 ORDER BY d.scheduled_for`, [customerKey]);
  return rows;
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('merchants stop colliding on the same customer account', () => {
  it('spreads debits that would land together', async () => {
    for (const m of MERCHANTS) await seed(m, 'ck_one', AT);

    const r = await deconflictScheduled(NOW);

    expect(r.collisions_before).toBeGreaterThan(0);
    expect(r.collisions_after).toBe(0);
    expect(r.moved).toBe(2);
  });

  it('leaves one debit where it was, and moves only the rest', async () => {
    for (const m of MERCHANTS) await seed(m, 'ck_one', AT);
    await deconflictScheduled(NOW);

    const rows = await times('ck_one');
    const stayed = rows.filter((r) => r.scheduled_for.getTime() === AT.getTime());
    expect(stayed).toHaveLength(1);
  });

  it('records why a debit was moved, on the decision itself', async () => {
    for (const m of MERCHANTS) await seed(m, 'ck_one', AT);
    await deconflictScheduled(NOW);

    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM decision d
         JOIN subscription s ON s.id = d.subscription_id
        WHERE s.customer_key = 'ck_one' AND d.explanation LIKE '%same-account collision%'`);
    expect(rows[0]!.n).toBe(2);
  });

  it('does nothing when debits are already spread', async () => {
    await seed('dc_a', 'ck_one', AT);
    await seed('dc_b', 'ck_one', new Date(AT.getTime() + 4 * 3600_000));

    const r = await deconflictScheduled(NOW);
    expect(r.collisions_before).toBe(0);
    expect(r.moved).toBe(0);
  });

  it('never moves a debit for a merchant that did not consent to cross-merchant signals', async () => {
    await seed('dc_a', 'ck_one', AT, true);
    await seed('dc_b', 'ck_one', AT, false);
    await seed('dc_c', 'ck_one', AT, true);

    const r = await deconflictScheduled(NOW);
    expect(r.considered).toBe(2);

    const { rows } = await query<{ scheduled_for: Date }>(
      `SELECT d.scheduled_for FROM decision d JOIN subscription s ON s.id = d.subscription_id
        WHERE s.merchant_id = 'dc_b'`);
    expect(rows[0]!.scheduled_for.getTime()).toBe(AT.getTime());
  });

  it('does not confuse two different customers who happen to share a time', async () => {
    await seed('dc_a', 'ck_one', AT);
    await seed('dc_b', 'ck_two', AT);

    const r = await deconflictScheduled(NOW);
    expect(r.customers).toBe(2);
    expect(r.collisions_before).toBe(0);
    expect(r.moved).toBe(0);
  });

  it('never touches a decision that already executed', async () => {
    for (const m of MERCHANTS) await seed(m, 'ck_one', AT);
    await query(`UPDATE decision SET executed_at = now(), outcome = 'recovered'
                  WHERE subscription_id = 'dc_c:sub'`);

    const r = await deconflictScheduled(NOW);
    expect(r.considered).toBe(2);

    const { rows } = await query<{ scheduled_for: Date }>(
      `SELECT scheduled_for FROM decision WHERE subscription_id = 'dc_c:sub'`);
    expect(rows[0]!.scheduled_for.getTime()).toBe(AT.getTime());
  });

  it('is safe to run when there is nothing scheduled', async () => {
    const r = await deconflictScheduled(NOW);
    expect(r.moved).toBe(0);
    expect(r.collisions_before).toBe(0);
  });
});
