import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TAXONOMY_VERSION } from '@mandate/core';
import { close, query } from '@mandate/db';
import { reclassify } from './reclassify.ts';

const MERCHANT = 'merchant_reclassify_test';
const OTHER = 'merchant_reclassify_other';
const NOW = new Date('2026-09-10T00:00:00.000Z');

async function seedMerchant(id: string) {
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [id]);
}

async function seedSubscription(merchant: string, sub: string, cycleEnd: Date) {
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, current_end)
     VALUES ($1,$2,$1,$1,'upi_autopay',49900,'active',$3,$4)`,
    [sub, merchant, new Date(cycleEnd.getTime() - 30 * 86_400_000), cycleEnd],
  );
}

async function seedAttempt(sub: string, err: {
  reason: string; source: string; bucket: string | null; version: string | null; counts: boolean;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       error_reason, error_source, bucket, taxonomy_version, counts_against_budget, initiated_by)
     VALUES ($1,$2,$2,'failed',49900,$3,$4,$5,$6,$7,'razorpay_default')
     RETURNING id::text AS id`,
    [sub, new Date('2026-09-01T00:00:00.000Z'), err.reason, err.source,
     err.bucket, err.version, err.counts],
  );
  return rows[0]!.id;
}

async function stored(id: string) {
  const { rows } = await query<{ bucket: string; taxonomy_version: string; counts_against_budget: boolean }>(
    `SELECT bucket, taxonomy_version, counts_against_budget FROM payment_attempt WHERE id = $1`, [id],
  );
  return rows[0]!;
}

async function reset() {
  for (const m of [MERCHANT, OTHER]) {
    await query(`DELETE FROM taxonomy_reclassification tr USING payment_attempt pa, subscription s
                  WHERE tr.attempt_id = pa.id AND pa.subscription_id = s.id AND s.merchant_id = $1`, [m]);
    await query(`DELETE FROM mandate_health mh USING subscription s
                  WHERE mh.subscription_id = s.id AND s.merchant_id = $1`, [m]);
    await query(`DELETE FROM payment_attempt pa USING subscription s
                  WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [m]);
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [m]);
    await query(`DELETE FROM merchant WHERE id = $1`, [m]);
  }
  await seedMerchant(MERCHANT);
  await seedMerchant(OTHER);
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

const CLOSED = new Date('2026-09-05T00:00:00.000Z');
const OPEN = new Date('2026-09-20T00:00:00.000Z');

describe('a taxonomy that learns must be able to re-read its own history', () => {
  it('reclassifies a code the seed taxonomy had never seen', async () => {
    const sub = `${MERCHANT}:s1`;
    await seedSubscription(MERCHANT, sub, CLOSED);
    const id = await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });

    const result = await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(result.changed).toBe(1);
    expect(result.transitions['UNKNOWN -> SOFT_TRANSIENT']).toBe(1);
    expect(await stored(id)).toMatchObject({
      bucket: 'SOFT_TRANSIENT', taxonomy_version: TAXONOMY_VERSION,
    });
  });

  it('writes nothing on a dry run', async () => {
    const sub = `${MERCHANT}:s2`;
    await seedSubscription(MERCHANT, sub, CLOSED);
    const id = await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });

    const result = await reclassify({ merchantId: MERCHANT, now: NOW });

    expect(result.applied).toBe(false);
    expect(result.changed).toBe(1);
    expect(await stored(id)).toMatchObject({ bucket: 'UNKNOWN', taxonomy_version: '0.1.0-seed' });
  });

  it('records an audit row so a changed number is always explainable', async () => {
    const sub = `${MERCHANT}:s3`;
    await seedSubscription(MERCHANT, sub, CLOSED);
    const id = await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });

    await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    const { rows } = await query<{ from_bucket: string; to_bucket: string; from_version: string }>(
      `SELECT from_bucket, to_bucket, from_version FROM taxonomy_reclassification WHERE attempt_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_bucket: 'UNKNOWN', to_bucket: 'SOFT_TRANSIENT', from_version: '0.1.0-seed',
    });
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const sub = `${MERCHANT}:s4`;
    await seedSubscription(MERCHANT, sub, CLOSED);
    await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });

    await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });
    const second = await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(second.scanned).toBe(0);
    expect(second.changed).toBe(0);
    const { rows } = await query(
      `SELECT 1 FROM taxonomy_reclassification tr
         JOIN payment_attempt pa ON pa.id = tr.attempt_id
         JOIN subscription s ON s.id = pa.subscription_id
        WHERE s.merchant_id = $1`, [MERCHANT]);
    expect(rows).toHaveLength(1);
  });

  it('does not touch another merchant', async () => {
    const mine = `${MERCHANT}:s5`;
    const theirs = `${OTHER}:s5`;
    await seedSubscription(MERCHANT, mine, CLOSED);
    await seedSubscription(OTHER, theirs, CLOSED);
    const theirId = await seedAttempt(theirs, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });
    await seedAttempt(mine, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: false,
    });

    await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(await stored(theirId)).toMatchObject({ bucket: 'UNKNOWN', taxonomy_version: '0.1.0-seed' });
  });
});

describe('reclassification must never silently hand back a live attempt budget', () => {
  it('refuses to change budget attribution on an open cycle', async () => {
    const sub = `${MERCHANT}:s6`;
    await seedSubscription(MERCHANT, sub, OPEN);
    const id = await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: true,
    });

    const result = await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(result.open_cycle_skipped).toBe(1);
    expect(result.changed).toBe(0);
    expect(await stored(id)).toMatchObject({ bucket: 'UNKNOWN', counts_against_budget: true });
  });

  it('frees the attempt on an open cycle only when explicitly allowed', async () => {
    const sub = `${MERCHANT}:s7`;
    await seedSubscription(MERCHANT, sub, OPEN);
    const id = await seedAttempt(sub, {
      reason: 'server_error', source: 'internal',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: true,
    });

    const result = await reclassify({
      merchantId: MERCHANT, apply: true, allowOpenCycles: true, now: NOW,
    });

    expect(result.open_cycle_skipped).toBe(0);
    expect(result.budget_freed).toBe(1);
    expect(await stored(id)).toMatchObject({ counts_against_budget: false });
  });

  it('still fixes the bucket on an open cycle when the budget is unaffected', async () => {
    const sub = `${MERCHANT}:s8`;
    await seedSubscription(MERCHANT, sub, OPEN);
    const id = await seedAttempt(sub, {
      reason: 'insufficient_funds', source: 'customer',
      bucket: 'UNKNOWN', version: '0.1.0-seed', counts: true,
    });

    const result = await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(result.open_cycle_skipped).toBe(0);
    expect(await stored(id)).toMatchObject({
      bucket: 'SOFT_LIQUIDITY', counts_against_budget: true,
    });
  });

  it('reports a budget being charged back, not only freed', async () => {
    const sub = `${MERCHANT}:s9`;
    await seedSubscription(MERCHANT, sub, CLOSED);
    await seedAttempt(sub, {
      reason: 'insufficient_funds', source: 'customer',
      bucket: 'SOFT_LIQUIDITY', version: '0.1.0-seed', counts: false,
    });

    const result = await reclassify({ merchantId: MERCHANT, apply: true, now: NOW });

    expect(result.budget_charged).toBe(1);
    expect(result.budget_freed).toBe(0);
  });
});
