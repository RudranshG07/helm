import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { openPromiseFor, recordPromise, reliabilityFor, resolvePromises } from './promise.ts';

const M = 'merchant_promise_test';
const S = `${M}:sub_p`;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const CYCLE = new Date('2026-08-25T00:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);

async function reset() {
  await query(`DELETE FROM promise_to_pay p USING subscription s
                WHERE p.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM outreach o USING subscription s
                WHERE o.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM mandate_health mh USING subscription s
                WHERE mh.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM decision d USING subscription s
                WHERE d.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM execution_intent i USING subscription s
                WHERE i.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM arm_assignment a USING subscription s
                WHERE a.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM payment_attempt pa USING subscription s
                WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(`INSERT INTO merchant (id, name, mode, write_enabled) VALUES ($1,$1,'test',TRUE)`, [M]);
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, current_end)
     VALUES ($1,$2,$1,$1,'upi_autopay',49900,'active',$3,$4)`,
    [S, M, CYCLE, new Date(NOW.getTime() + 20 * 86_400_000)],
  );
}

async function attempt(status: string, at: Date) {
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       initiated_by, source) VALUES ($1,$2,$3,$4,49900,'mandate_rescue','executor')`,
    [S, CYCLE, at, status],
  );
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('a customer can tell us when they will have the money', () => {
  it('records the promise against the open cycle', async () => {
    const r = await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(4), now: NOW });
    expect(r.ok).toBe(true);
    const p = await openPromiseFor(S, CYCLE);
    expect(p?.promised_for).toBe(day(4));
  });

  it('refuses a date we could not honour', async () => {
    const r = await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(-3), now: NOW });
    expect(r.ok).toBe(false);
    expect(await openPromiseFor(S, CYCLE)).toBeNull();
  });

  it('lets a customer change their mind, keeping only one open promise', async () => {
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(3), now: NOW });
    const second = await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(6), now: NOW });
    expect(second.ok && second.superseded).toBe(1);

    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM promise_to_pay WHERE subscription_id = $1 AND status = 'open'`, [S]);
    expect(rows[0]!.n).toBe(1);
    expect((await openPromiseFor(S, CYCLE))?.promised_for).toBe(day(6));
  });

  it('keeps the superseded promise as history rather than deleting it', async () => {
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(3), now: NOW });
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(6), now: NOW });
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM promise_to_pay WHERE subscription_id = $1 AND status = 'superseded'`, [S]);
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a promise for a subscription that no longer exists', async () => {
    const r = await recordPromise({ subscription_id: 'nope', outreach_id: null, promised_for: day(4), now: NOW });
    expect(r.ok).toBe(false);
  });
});

describe('a promise is settled by what actually happened', () => {
  it('marks it kept when a charge succeeded after it was made', async () => {
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(2), now: NOW });
    await attempt('captured', new Date(Date.now() + 5_000));
    const r = await resolvePromises(new Date());
    expect(r.kept).toBe(1);
  });

  it('marks it broken when the date passed and the charge failed', async () => {
    await query(
      `INSERT INTO promise_to_pay (subscription_id, cycle, promised_for, amount_paise, status, source)
       VALUES ($1,$2,$3,49900,'open','customer')`,
      [S, CYCLE, '2026-08-27'],
    );
    await attempt('failed', new Date(Date.now() + 5_000));
    const r = await resolvePromises(new Date());
    expect(r.broken).toBe(1);
  });

  it('leaves a promise open while its date is still ahead', async () => {
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(10), now: NOW });
    await attempt('failed', new Date(Date.now() + 5_000));
    const r = await resolvePromises(new Date());
    expect(r.kept + r.broken).toBe(0);
    expect(await openPromiseFor(S, CYCLE)).not.toBeNull();
  });

  it('never counts a charge that happened before the promise was made', async () => {
    await attempt('captured', new Date(Date.now() - 600_000));
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(2), now: NOW });
    const r = await resolvePromises(new Date());
    expect(r.kept).toBe(0);
  });

  it('builds a reliability record the next cycle can use', async () => {
    await recordPromise({ subscription_id: S, outreach_id: null, promised_for: day(2), now: NOW });
    await attempt('captured', new Date(Date.now() + 5_000));
    await resolvePromises(new Date());
    const rel = await reliabilityFor(S);
    expect(rel.kept).toBe(1);
    expect(rel.rate).toBe(1);
  });
});
