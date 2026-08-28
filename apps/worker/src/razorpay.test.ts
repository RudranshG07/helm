import { describe, expect, it } from 'vitest';
import { DuplicateReceiptError } from './gateway.ts';
import { MissingTokenError, RazorpayApiError, RazorpayGateway } from './razorpay.ts';
import type { Transport } from './razorpay.ts';

const CREDS = { keyId: 'rzp_test_abc123', keySecret: 'secret_xyz' };
const TOKEN = { token_id: 'token_ABC', customer_id: 'cust_ABC' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface ResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

function recorder(responses: ResponseSpec[]) {
  const calls: Call[] = [];
  let i = 0;

  const transport: Transport = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : null,
    });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as Response;
  };

  return { calls, transport };
}

function gateway(transport: Transport, token: typeof TOKEN | null = TOKEN) {
  return new RazorpayGateway({
    credentials: CREDS,
    transport,
    tokenLookup: async () => token,
  });
}

const charge = {
  receipt: 'mr_m:sub_1_1788220800_2',
  amount_paise: 149900,
  subscription_id: 'm:sub_1',
  rzp_subscription_id: 'sub_1',
  scheduled_for: new Date('2026-09-03T02:30:00.000Z'),
};

describe('the request shape matches what Razorpay documents', () => {
  it('sends basic auth built from the key pair', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_1', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);

    const expected = `Basic ${Buffer.from('rzp_test_abc123:secret_xyz').toString('base64')}`;
    expect(calls[0]!.headers['Authorization']).toBe(expected);
  });

  it('creates the order with our receipt as the idempotency key', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_1', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);

    expect(calls[0]!.url).toContain('/orders');
    expect((calls[0]!.body as Record<string, unknown>)['receipt']).toBe(charge.receipt);
  });

  it('sends the amount in paise as an integer, never a rupee float', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_1', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);

    const amount = (calls[0]!.body as Record<string, unknown>)['amount'];
    expect(amount).toBe(149900);
    expect(Number.isInteger(amount)).toBe(true);
  });

  it('requests the pre-debit notification with payment_after as unix seconds', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_1', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);

    const notification = (calls[0]!.body as Record<string, Record<string, unknown>>)['notification']!;
    expect(notification['token_id']).toBe('token_ABC');
    expect(notification['payment_after']).toBe(Math.floor(charge.scheduled_for.getTime() / 1000));
  });

  it('charges against the order it just created, with recurring set', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_created', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);

    const body = calls[1]!.body as Record<string, unknown>;
    expect(calls[1]!.url).toContain('/payments/create/recurring');
    expect(body['order_id']).toBe('order_created');
    expect(body['recurring']).toBe(true);
    expect(body['token']).toBe('token_ABC');
  });

  it('never puts the key secret in a URL', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'order_1', receipt: charge.receipt, status: 'created' } },
      { body: { id: 'pay_1', status: 'captured' } },
    ]);
    await gateway(transport).createOrderAndCharge(charge);
    for (const c of calls) expect(c.url).not.toContain('secret_xyz');
  });
});

describe('errors map onto behaviour the executor already handles', () => {
  it('turns a duplicate receipt rejection into DuplicateReceiptError', async () => {
    const { transport } = recorder([
      {
        ok: false, status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Receipt should be unique' } },
      },
    ]);
    await expect(gateway(transport).createOrderAndCharge(charge)).rejects.toBeInstanceOf(DuplicateReceiptError);
  });

  it('raises a typed error for anything else, carrying the status and code', async () => {
    const { transport } = recorder([
      { ok: false, status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } },
    ]);
    await expect(gateway(transport).createOrderAndCharge(charge)).rejects.toMatchObject({
      name: 'RazorpayApiError', status: 401,
    });
  });

  it('raises rather than charging when no token is recorded', async () => {
    const { transport } = recorder([{ body: {} }]);
    await expect(gateway(transport, null).createOrderAndCharge(charge)).rejects.toBeInstanceOf(MissingTokenError);
  });

  it('does not reach the gateway at all when the token is missing', async () => {
    const { calls, transport } = recorder([{ body: {} }]);
    await gateway(transport, null).createOrderAndCharge(charge).catch(() => {});
    expect(calls).toHaveLength(0);
  });

  it('raises on an unparseable body rather than returning undefined', async () => {
    const transport: Transport = async () => ({ ok: true, status: 200, text: async () => 'not json' } as Response);
    await expect(gateway(transport).createOrderAndCharge(charge)).rejects.toBeInstanceOf(RazorpayApiError);
  });
});

describe('reconciliation lookup', () => {
  it('finds an existing order by receipt and returns its payments', async () => {
    const { calls, transport } = recorder([
      { body: { count: 1, items: [{ id: 'order_9', receipt: charge.receipt, status: 'paid' }] } },
      { body: { count: 1, items: [{ id: 'pay_9', status: 'captured' }] } },
    ]);
    const found = await gateway(transport).findOrderByReceipt(charge.receipt);

    expect(found?.order.id).toBe('order_9');
    expect(found?.payments[0]!.status).toBe('captured');
    expect(calls[0]!.url).toContain(encodeURIComponent(charge.receipt));
  });

  it('returns null when no order exists, so the reconciler can abandon the intent', async () => {
    const { transport } = recorder([{ body: { count: 0, items: [] } }]);
    expect(await gateway(transport).findOrderByReceipt('mr_nope')).toBeNull();
  });

  it('returns an order with no payments rather than inventing one', async () => {
    const { transport } = recorder([
      { body: { count: 1, items: [{ id: 'order_9', receipt: 'r', status: 'created' }] } },
      { body: { count: 0, items: [] } },
    ]);
    const found = await gateway(transport).findOrderByReceipt('r');
    expect(found?.payments).toEqual([]);
  });

  it.each([
    ['created', 'created'], ['authorized', 'authorized'], ['captured', 'captured'],
    ['failed', 'failed'], ['refunded', 'captured'], ['something_new', 'created'],
  ])('maps payment status %s to %s', async (given, expected) => {
    const { transport } = recorder([
      { body: { count: 1, items: [{ id: 'order_9', receipt: 'r', status: 'paid' }] } },
      { body: { count: 1, items: [{ id: 'pay_9', status: given }] } },
    ]);
    const found = await gateway(transport).findOrderByReceipt('r');
    expect(found?.payments[0]!.status).toBe(expected);
  });
});

describe('mode and key must agree before anything can charge', () => {
  it('refuses a live key while the mode is test', async () => {
    const { makeGateway } = await import('./gateway-factory.ts');
    process.env['RAZORPAY_KEY_ID'] = 'rzp_live_abc';
    process.env['RAZORPAY_KEY_SECRET'] = 's';
    process.env['RAZORPAY_MODE'] = 'test';
    expect(() => makeGateway()).toThrow(/live key/i);
  });

  it('refuses a test key while the mode is live', async () => {
    const { makeGateway } = await import('./gateway-factory.ts');
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_abc';
    process.env['RAZORPAY_KEY_SECRET'] = 's';
    process.env['RAZORPAY_MODE'] = 'live';
    expect(() => makeGateway()).toThrow(/live/i);
  });

  it('falls back to a gateway that refuses to charge when no credentials exist', async () => {
    const { makeGateway } = await import('./gateway-factory.ts');
    delete process.env['RAZORPAY_KEY_ID'];
    delete process.env['RAZORPAY_KEY_SECRET'];
    delete process.env['RAZORPAY_MODE'];
    const g = makeGateway();
    await expect(
      g.createOrderAndCharge({ ...charge }),
    ).rejects.toThrow(/no live gateway/i);
  });
});
