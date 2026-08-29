import { describe, expect, it } from 'vitest';
import { DEFAULT_MANDATES, RazorpaySetup } from './razorpay.ts';
import type { Transport } from '../razorpay.ts';

function recorder(responses: { ok?: boolean; status?: number; body?: unknown }[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
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

function setup(transport: Transport) {
  return new RazorpaySetup({ keyId: 'rzp_test_abc', keySecret: 'secret', transport });
}

describe('key check happens before anything is created', () => {
  it('reports reachable when the keys work', async () => {
    const { transport } = recorder([{ body: { count: 0, items: [] } }]);
    expect(await setup(transport).whoami()).toEqual({ reachable: true, problem: null });
  });

  it('reports the problem rather than throwing when keys are rejected', async () => {
    const { transport } = recorder([
      { ok: false, status: 401, body: { error: { code: 'X', description: 'Authentication failed' } } },
    ]);
    const r = await setup(transport).whoami();
    expect(r.reachable).toBe(false);
    expect(r.problem).toContain('401');
  });
});

describe('plan and subscription creation', () => {
  it('creates a monthly plan with the amount in paise', async () => {
    const { calls, transport } = recorder([{ body: { id: 'plan_1', item: { name: 'Gym', amount: 149900 } } }]);
    await setup(transport).createPlan('Gym', 149900);

    const body = calls[0]!.body as Record<string, Record<string, unknown>>;
    expect(calls[0]!.url).toContain('/plans');
    expect(body['period']).toBe('monthly');
    expect(body['item']!['amount']).toBe(149900);
    expect(Number.isInteger(body['item']!['amount'])).toBe(true);
  });

  it('tags what it creates so a test account can be cleaned up', async () => {
    const { calls, transport } = recorder([{ body: { id: 'plan_1', item: { name: 'x', amount: 1 } } }]);
    await setup(transport).createPlan('x', 1);
    const body = calls[0]!.body as Record<string, Record<string, unknown>>;
    expect(body['notes']!['created_by']).toBe('helm_setup');
  });

  it('creates a subscription against the plan and returns its authorisation link', async () => {
    const { calls, transport } = recorder([
      { body: { id: 'sub_1', status: 'created', short_url: 'https://rzp.io/i/abc' } },
    ]);
    const sub = await setup(transport).createSubscription('plan_1');

    expect(calls[0]!.url).toContain('/subscriptions');
    expect((calls[0]!.body as Record<string, unknown>)['plan_id']).toBe('plan_1');
    expect(sub.short_url).toBe('https://rzp.io/i/abc');
  });

  it('does not notify the customer, because these are test mandates', async () => {
    const { calls, transport } = recorder([{ body: { id: 'sub_1', status: 'created', short_url: null } }]);
    await setup(transport).createSubscription('plan_1');
    expect((calls[0]!.body as Record<string, unknown>)['customer_notify']).toBe(0);
  });
});

describe('webhook registration', () => {
  it('registers every event the ingest path handles', async () => {
    const { calls, transport } = recorder([{ body: { id: 'hook_1', url: 'https://x/webhooks/razorpay' } }]);
    await setup(transport).registerWebhook('https://x/webhooks/razorpay', 'whsec');

    const events = (calls[0]!.body as Record<string, string[]>)['events']!;
    for (const needed of ['subscription.pending', 'subscription.halted', 'payment.failed', 'payment.downtime.started']) {
      expect(events).toContain(needed);
    }
  });

  it('sends the secret so signatures can be verified', async () => {
    const { calls, transport } = recorder([{ body: { id: 'hook_1', url: 'x' } }]);
    await setup(transport).registerWebhook('https://x/webhooks/razorpay', 'whsec_helm');
    expect((calls[0]!.body as Record<string, unknown>)['secret']).toBe('whsec_helm');
  });
});

describe('the seeded mandate set', () => {
  it('covers a spread of amounts, so the amount effect is testable', () => {
    const amounts = DEFAULT_MANDATES.map((m) => m.amount_paise);
    expect(Math.max(...amounts) / Math.min(...amounts)).toBeGreaterThan(10);
  });

  it('creates enough mandates to call it a batch', () => {
    expect(DEFAULT_MANDATES.reduce((s, m) => s + m.count, 0)).toBeGreaterThanOrEqual(15);
  });

  it('uses realistic Indian recurring-billing categories', () => {
    const names = DEFAULT_MANDATES.map((m) => m.name.toLowerCase()).join(' ');
    expect(names).toMatch(/gym|tiffin|coaching/);
  });
});
