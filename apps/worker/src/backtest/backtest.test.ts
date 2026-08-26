import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { AsOfLoader, LeakageError, loadHistory } from './loader.ts';
import { renderBacktest } from './report.ts';
import { runBacktest } from './run.ts';

const MERCHANT = 'merchant_backtest';
const SUB = `${MERCHANT}:sub_bt`;
const CYCLE = new Date('2026-06-01T00:00:00.000Z');

async function reset() {
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
  await query(`DELETE FROM subscription WHERE id = $1`, [SUB]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
  await query(`INSERT INTO merchant (id, name, mode) VALUES ($1,$1,'test')`, [MERCHANT]);
  await query(
    `INSERT INTO subscription (id, merchant_id, rzp_subscription_id, customer_ref, method,
       amount_paise, status, current_start, mandate_expiry_at)
     VALUES ($1,$2,'sub_bt','cust_bt','upi_autopay',49900,'pending',$3,'2027-01-01')`,
    [SUB, MERCHANT, CYCLE],
  );
}

async function attempt(opts: {
  at: string;
  status: string;
  reason?: string | null;
  bucket?: string | null;
  by?: string;
  cycle?: Date;
}) {
  await query(
    `INSERT INTO payment_attempt (subscription_id, cycle, attempted_at, status, amount_paise,
       error_reason, bucket, initiated_by)
     VALUES ($1,$2,$3,$4,49900,$5,$6,$7)`,
    [SUB, opts.cycle ?? CYCLE, new Date(opts.at), opts.status,
     opts.reason ?? null, opts.bucket ?? null, opts.by ?? 'razorpay_default'],
  );
}

afterAll(async () => {
  await query(`DELETE FROM payment_attempt WHERE subscription_id = $1`, [SUB]);
  await close();
});

describe('the loader cannot see the future', () => {
  it('returns only attempts strictly before the cutoff', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-02T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-03T10:00:00Z', status: 'captured' });

    const loader = new AsOfLoader(new Date('2026-06-02T10:00:00Z'));
    const prior = await loader.priorState(SUB, CYCLE);

    expect(prior.attempts_before).toBe(1);
    expect(prior.captured_before).toBe(false);
  });

  it('excludes a row exactly at the cutoff, not just after it', async () => {
    await reset();
    await attempt({ at: '2026-06-02T10:00:00Z', status: 'captured' });

    const prior = await new AsOfLoader(new Date('2026-06-02T10:00:00Z')).priorState(SUB, CYCLE);
    expect(prior.captured_before).toBe(false);
  });

  it('does not let a later success contaminate the liquidity window', async () => {
    await reset();
    await attempt({ at: '2026-06-03T10:00:00Z', status: 'captured' });
    await attempt({ at: '2026-06-04T10:00:00Z', status: 'captured' });
    await attempt({ at: '2026-06-05T10:00:00Z', status: 'captured' });

    const prior = await new AsOfLoader(new Date('2026-06-01T00:00:00Z')).priorState(SUB, CYCLE);
    expect(prior.success_days).toEqual([]);
  });

  it('refuses an invalid cutoff rather than defaulting to everything', () => {
    expect(() => new AsOfLoader(new Date('nonsense'))).toThrow(LeakageError);
  });

  it('exposes its own cutoff so a caller can assert against it', () => {
    const at = new Date('2026-06-02T10:00:00Z');
    expect(new AsOfLoader(at).cutoff).toBe(at);
  });
});

describe('the replay', () => {
  it('is deterministic across runs on the same data', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-02T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const a = await runBacktest(MERCHANT);
    const b = await runBacktest(MERCHANT);

    expect(a.totals).toEqual(b.totals);
    expect(a.decision_points.map((p) => p.our_rule_id)).toEqual(b.decision_points.map((p) => p.our_rule_id));
  });

  it('refuses to authorise a retry after a hard decline', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'payment_cancelled' });

    const result = await runBacktest(MERCHANT);
    const point = result.decision_points[0]!;

    expect(point.bucket).toBe('HARD_CUSTOMER');
    expect(point.our_action).toBe('STOP');
    expect(result.totals.our_attempts_authorised).toBe(0);
  });

  it('counts the attempts the default schedule spent on a hard decline', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'payment_cancelled' });
    await attempt({ at: '2026-06-02T10:00:00Z', status: 'failed', reason: 'payment_cancelled' });
    await attempt({ at: '2026-06-03T10:00:00Z', status: 'failed', reason: 'payment_cancelled' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.default_attempts_on_hard_declines).toBeGreaterThan(0);
  });

  it('authorises a retry on a soft decline with budget left', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const result = await runBacktest(MERCHANT);
    expect(result.decision_points[0]!.our_action).toBe('RETRY_SCHEDULED');
    expect(result.totals.our_attempts_authorised).toBe(1);
  });

  it('refuses once the budget is exhausted', async () => {
    await reset();
    for (let d = 1; d <= 5; d += 1) {
      await attempt({ at: `2026-06-0${d}T10:00:00Z`, status: 'failed', reason: 'insufficient_funds' });
    }
    const result = await runBacktest(MERCHANT);
    expect(result.totals.our_refusals_by_rule['R-BUDGET']).toBeGreaterThan(0);
  });

  it('reports which tier the timing model actually used', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.liquidity_tiers['population_default']).toBe(1);
  });

  it('counts unmapped failures as an honesty metric', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'a_code_from_the_future' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.unmapped_failures).toBe(1);
  });

  it('records the amount at risk as a denominator', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.amount_at_risk_paise).toBe(49900);
  });
});

describe('the report refuses to overclaim', () => {
  it('never states a recovery figure attributable to this policy', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    const md = renderBacktest(await runBacktest(MERCHANT), 'test mode');

    expect(md).toContain('does not claim a recovery figure');
    expect(md).not.toMatch(/we would have recovered/i);
  });

  it('prints its own provenance next to the numbers', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    const md = renderBacktest(await runBacktest(MERCHANT), 'Razorpay test mode');
    expect(md).toContain('Razorpay test mode');
  });

  it('says so plainly when the timing model is not predicting anything', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    const md = renderBacktest(await runBacktest(MERCHANT), 'test mode');
    expect(md).toContain('not making a real prediction');
  });

  it('prints an empty report rather than fabricating one', async () => {
    await reset();
    const md = renderBacktest(await runBacktest(MERCHANT), 'test mode');
    expect(md).toContain('empty on purpose rather than fabricated');
  });

  it('always prints the denominator beside the amount', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    const md = renderBacktest(await runBacktest(MERCHANT), 'test mode');
    expect(md).toContain('the denominator');
  });
});

describe('loadHistory', () => {
  it('returns attempts in chronological order', async () => {
    await reset();
    await attempt({ at: '2026-06-03T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const rows = await loadHistory(MERCHANT);
    expect(rows[0]!.attempted_at.getTime()).toBeLessThan(rows[1]!.attempted_at.getTime());
  });
});

describe('a timing adjustment is not a refusal', () => {
  it('counts an attempt moved out of a peak window as authorised, not refused', async () => {
    await reset();
    await attempt({ at: '2026-06-01T10:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.our_attempts_authorised).toBe(1);
    expect(result.totals.our_attempts_rescheduled).toBe(1);
    expect(result.totals.our_refusals_by_rule['R-WINDOW']).toBeUndefined();
  });

  it('counts how many of the default schedule\'s retries landed in a peak window', async () => {
    await reset();
    await attempt({ at: '2026-06-01T06:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-02T06:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-03T06:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.default_attempts_in_peak_windows).toBeGreaterThan(0);
  });

  it('says in the report why a fixed offset repeats a bad time of day', async () => {
    await reset();
    await attempt({ at: '2026-06-01T06:00:00Z', status: 'failed', reason: 'insufficient_funds' });
    await attempt({ at: '2026-06-02T06:00:00Z', status: 'failed', reason: 'insufficient_funds' });

    const md = renderBacktest(await runBacktest(MERCHANT), 'test mode');
    expect(md).toContain('peak execution window');
  });

  it('still counts a genuine refusal as a refusal', async () => {
    await reset();
    await attempt({ at: '2026-06-01T06:00:00Z', status: 'failed', reason: 'payment_cancelled' });

    const result = await runBacktest(MERCHANT);
    expect(result.totals.our_attempts_authorised).toBe(0);
    expect(Object.keys(result.totals.our_refusals_by_rule).length).toBeGreaterThan(0);
  });
});
