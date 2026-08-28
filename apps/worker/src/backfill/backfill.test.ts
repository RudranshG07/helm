import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { MAX_PAGE_SIZE, RazorpayReader } from './client.ts';
import type { RazorpayPaymentRecord } from './client.ts';
import { backfill } from './run.ts';
import type { Transport } from '../razorpay.ts';

const MERCHANT = 'merchant_backfill_test';

function payment(i: number, over: Partial<RazorpayPaymentRecord> = {}): RazorpayPaymentRecord {
  return {
    id: `pay_bf_${i}`,
    order_id: `order_${i}`,
    invoice_id: `inv_${Math.ceil(i / 3)}`,
    customer_id: `cust_${Math.ceil(i / 3)}`,
    amount: 49900,
    status: 'failed',
    method: 'upi',
    created_at: Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000) + i * 3600,
    error_code: 'BAD_REQUEST_ERROR',
    error_description: 'insufficient funds',
    error_source: 'customer',
    error_step: 'payment_authentication',
    error_reason: 'insufficient_funds',
    bank: 'HDFC',
    ...over,
  };
}

function pages(items: RazorpayPaymentRecord[][], statuses: number[] = []) {
  const calls: string[] = [];
  let i = 0;
  const transport: Transport = async (url) => {
    calls.push(url);
    const status = statuses[i] ?? 200;
    const body = status === 200 ? { count: items[i]?.length ?? 0, items: items[i] ?? [] } : { error: { code: 'X', description: 'boom' } };
    if (status === 200) i += 1; else i += 1;
    return { ok: status === 200, status, text: async () => JSON.stringify(body) } as Response;
  };
  return { calls, transport };
}

async function reset() {
  await query(`DELETE FROM mandate_health WHERE subscription_id LIKE $1`, [`${MERCHANT}:%`]);
  await query(`DELETE FROM payment_attempt WHERE subscription_id LIKE $1`, [`${MERCHANT}:%`]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [MERCHANT]);
  await query(`DELETE FROM merchant WHERE id = $1`, [MERCHANT]);
}

afterAll(async () => {
  await reset();
  await close();
});

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-09-01T00:00:00Z');

describe('pagination', () => {
  it('walks every page until a short page ends it', async () => {
    const full = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => payment(i + 1));
    const { calls, transport } = pages([full, [payment(999)]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport });

    await reset();
    const result = await backfill(reader, MERCHANT, FROM, TO);

    expect(result.pages).toBe(2);
    expect(result.payments_seen).toBe(MAX_PAGE_SIZE + 1);
    expect(calls[1]).toContain(`skip=${MAX_PAGE_SIZE}`);
  });

  it('stops immediately on an empty first page', async () => {
    const { transport } = pages([[]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport });
    await reset();
    expect((await backfill(reader, MERCHANT, FROM, TO)).pages).toBe(0);
  });

  it('sends the window as unix seconds', async () => {
    const { calls, transport } = pages([[]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport });
    await reset();
    await backfill(reader, MERCHANT, FROM, TO);
    expect(calls[0]).toContain(`from=${Math.floor(FROM.getTime() / 1000)}`);
    expect(calls[0]).toContain(`to=${Math.floor(TO.getTime() / 1000)}`);
  });

  it('never asks for more than the page limit', async () => {
    const { calls, transport } = pages([[]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport, pageSize: 9999 });
    await reset();
    await backfill(reader, MERCHANT, FROM, TO);
    expect(calls[0]).toContain(`count=${MAX_PAGE_SIZE}`);
  });

  it('stops at the page ceiling rather than looping forever on a bad API', async () => {
    const full = Array.from({ length: 10 }, (_, i) => payment(i + 1));
    const transport: Transport = async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify({ count: 10, items: full }) } as Response);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport, pageSize: 10, maxPages: 3 });
    await reset();
    expect((await backfill(reader, MERCHANT, FROM, TO)).pages).toBe(3);
  });
});

describe('transient failures', () => {
  it('retries a rate limit and succeeds', async () => {
    let n = 0;
    const transport: Transport = async () => {
      n += 1;
      if (n <= 2) return { ok: false, status: 429, text: async () => '{}' } as Response;
      return { ok: true, status: 200, text: async () => JSON.stringify({ count: 1, items: [payment(1)] }) } as Response;
    };
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport, sleep: async () => {} });
    await reset();
    const result = await backfill(reader, MERCHANT, FROM, TO);
    expect(reader.retries).toBe(2);
    expect(result.payments_seen).toBe(1);
  });

  it('gives up on a permanent error rather than retrying forever', async () => {
    const transport: Transport = async () =>
      ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'X', description: 'Authentication failed' } }) } as Response);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport, sleep: async () => {} });
    await reset();
    await expect(backfill(reader, MERCHANT, FROM, TO)).rejects.toMatchObject({ status: 401 });
    expect(reader.retries).toBe(0);
  });
});

describe('what lands in the database', () => {
  it('groups payments under their invoice so a cycle can be reconstructed', async () => {
    const { transport } = pages([[payment(1), payment(2), payment(3), payment(4)]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport });
    await reset();
    const result = await backfill(reader, MERCHANT, FROM, TO);
    expect(result.subscriptions_touched).toBe(2);
  });

  it('classifies each attempt on the way in', async () => {
    const { transport } = pages([[payment(1)]]);
    await reset();
    await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport }), MERCHANT, FROM, TO);
    const { rows } = await query<{ bucket: string }>(
      `SELECT bucket FROM payment_attempt WHERE rzp_payment_id = 'pay_bf_1'`,
    );
    expect(rows[0]!.bucket).toBe('SOFT_LIQUIDITY');
  });

  it('marks backfilled attempts as not counting against a live budget', async () => {
    const { transport } = pages([[payment(1)]]);
    await reset();
    await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport }), MERCHANT, FROM, TO);
    const { rows } = await query<{ counts_against_budget: boolean; source: string }>(
      `SELECT counts_against_budget, source FROM payment_attempt WHERE rzp_payment_id = 'pay_bf_1'`,
    );
    expect(rows[0]!.counts_against_budget).toBe(false);
    expect(rows[0]!.source).toBe('backfill');
  });

  it('is idempotent, so a re-run does not double the history', async () => {
    await reset();
    const first = pages([[payment(1), payment(2)]]);
    await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport: first.transport }), MERCHANT, FROM, TO);

    const second = pages([[payment(1), payment(2)]]);
    const result = await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport: second.transport }), MERCHANT, FROM, TO);

    expect(result.attempts_inserted).toBe(0);
    expect(result.attempts_duplicate).toBe(2);
  });

  it('skips a payment with nothing to group it under, and counts the skip', async () => {
    const { transport } = pages([[payment(1, { invoice_id: null, order_id: null })]]);
    await reset();
    const result = await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport }), MERCHANT, FROM, TO);
    expect(result.skipped_no_group).toBe(1);
    expect(result.attempts_inserted).toBe(0);
  });

  it('maps the gateway method onto ours', async () => {
    const { transport } = pages([[payment(1, { method: 'nach' })]]);
    await reset();
    await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport }), MERCHANT, FROM, TO);
    const { rows } = await query<{ method: string }>(
      `SELECT method FROM subscription WHERE merchant_id = $1`, [MERCHANT],
    );
    expect(rows[0]!.method).toBe('emandate');
  });

  it('records a captured payment as captured, so the models see successes too', async () => {
    const { transport } = pages([[payment(1, { status: 'captured', error_reason: null })]]);
    await reset();
    await backfill(new RazorpayReader({ keyId: 'k', keySecret: 's', transport }), MERCHANT, FROM, TO);
    const { rows } = await query<{ status: string }>(
      `SELECT status FROM payment_attempt WHERE rzp_payment_id = 'pay_bf_1'`,
    );
    expect(rows[0]!.status).toBe('captured');
  });

  it('reports how many requests it made, so rate limits are visible', async () => {
    const { transport } = pages([[payment(1)]]);
    const reader = new RazorpayReader({ keyId: 'k', keySecret: 's', transport });
    await reset();
    expect((await backfill(reader, MERCHANT, FROM, TO)).requests).toBeGreaterThan(0);
  });
});
