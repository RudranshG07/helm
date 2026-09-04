import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import {
  MODEL_TTL_MS, OUTCOME_WINDOW_DAYS, getSuccessModel, invalidateSuccessModel, loadOutcomes,
} from './planner.ts';

const M = 'merchant_model_cache_test';
const S = `${M}:sub`;

async function reset() {
  await query(`DELETE FROM mandate_health mh USING subscription s
                WHERE mh.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM decision d USING subscription s
                WHERE d.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM payment_attempt pa USING subscription s
                WHERE pa.subscription_id = s.id AND s.merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [M]);
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start)
     VALUES ($1,$2,$1,$1,'upi_autopay',49900,'active',now())`, [S, M]);
  invalidateSuccessModel();
}

async function attempt(status: string, daysAgo: number) {
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       bucket, issuer, initiated_by, source)
     VALUES ($1, date_trunc('month', now()), now() - ($2::int * interval '1 day'), $3, 49900,
             'SOFT_LIQUIDITY','HDFC','razorpay_default','webhook')`,
    [S, daysAgo, status],
  );
}

beforeEach(reset);
afterAll(async () => { await reset(); await close(); });

describe('the success model is not rebuilt from scratch on every tick', () => {
  it('builds once and serves the same model within the window', async () => {
    await attempt('captured', 1);
    const first = await getSuccessModel(M);
    const second = await getSuccessModel(M);

    expect(first.rebuilt).toBe(true);
    expect(second.rebuilt).toBe(false);
    expect(second.model).toBe(first.model);
  });

  it('rebuilds once the cached model is stale', async () => {
    await attempt('captured', 1);
    const now = Date.now();
    await getSuccessModel(M, now);
    const later = await getSuccessModel(M, now + MODEL_TTL_MS + 1);
    expect(later.rebuilt).toBe(true);
  });

  it('does not serve one merchant a model built for another', async () => {
    await attempt('captured', 1);
    await getSuccessModel(M);
    const other = await getSuccessModel('someone_else');
    expect(other.rebuilt).toBe(true);
  });

  it('can be invalidated deliberately', async () => {
    await attempt('captured', 1);
    await getSuccessModel(M);
    invalidateSuccessModel();
    expect((await getSuccessModel(M)).rebuilt).toBe(true);
  });

  it('reports how stale the model it served is', async () => {
    await attempt('captured', 1);
    const now = Date.now();
    await getSuccessModel(M, now);
    const handle = await getSuccessModel(M, now + 1000);
    expect(handle.age_ms).toBe(1000);
  });
});

describe('history is bounded, so the model cannot grow without limit', () => {
  it('loads outcomes inside the window', async () => {
    await attempt('captured', 5);
    expect(await loadOutcomes(M)).toHaveLength(1);
  });

  it('ignores outcomes older than the window', async () => {
    await attempt('captured', OUTCOME_WINDOW_DAYS + 30);
    expect(await loadOutcomes(M)).toHaveLength(0);
  });

  it('keeps a window short enough to bound memory and long enough to learn', () => {
    expect(OUTCOME_WINDOW_DAYS).toBeGreaterThanOrEqual(90);
    expect(OUTCOME_WINDOW_DAYS).toBeLessThanOrEqual(365);
  });

  it('honours an explicit narrower window', async () => {
    await attempt('captured', 40);
    expect(await loadOutcomes(M, 10)).toHaveLength(0);
    expect(await loadOutcomes(M, 90)).toHaveLength(1);
  });
});
