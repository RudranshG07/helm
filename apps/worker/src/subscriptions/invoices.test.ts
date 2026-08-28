import { describe, expect, it } from 'vitest';
import { InvoiceReader, assessInvoice, rankQueue } from './invoices.ts';
import type { InvoiceRecord, QueueItem } from './invoices.ts';
import type { Transport } from '../razorpay.ts';

const NOW = new Date('2026-09-01T00:00:00Z');

function invoice(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'inv_1',
    subscription_id: 'sub_1',
    customer_id: 'cust_1',
    status: 'issued',
    amount: 149900,
    amount_paid: 0,
    amount_due: 149900,
    issued_at: 1788220800,
    expire_by: null,
    short_url: 'https://rzp.io/i/abc',
    ...over,
  };
}

describe('chargeability', () => {
  it('an issued outstanding invoice on UPI is chargeable', () => {
    const a = assessInvoice(invoice(), 'upi_autopay', NOW);
    expect(a.chargeable).toBe(true);
    expect(a.explanation).toContain('does not consume the subscription retry budget');
  });

  it('a domestic card can never be charged manually, and says why', () => {
    const a = assessInvoice(invoice(), 'card', NOW);
    expect(a.chargeable).toBe(false);
    expect(a.reason).toBe('domestic_card');
    expect(a.explanation).toContain('cannot be attempted by anyone');
  });

  it('a paid invoice is not chargeable', () => {
    const a = assessInvoice(invoice({ status: 'paid', amount_due: 0 }), 'upi_autopay', NOW);
    expect(a.chargeable).toBe(false);
    expect(a.reason).toBe('already_paid');
  });

  it('an invoice with nothing due is not chargeable even if still marked issued', () => {
    const a = assessInvoice(invoice({ amount_due: 0 }), 'upi_autopay', NOW);
    expect(a.reason).toBe('already_paid');
  });

  it('a draft invoice is not chargeable', () => {
    expect(assessInvoice(invoice({ status: 'draft' }), 'upi_autopay', NOW).reason).toBe('not_issued');
  });

  it('an expired invoice is not chargeable', () => {
    const past = Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000);
    expect(assessInvoice(invoice({ expire_by: past }), 'upi_autopay', NOW).reason).toBe('expired');
  });

  it('an invoice expiring later is still chargeable', () => {
    const future = Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000);
    expect(assessInvoice(invoice({ expire_by: future }), 'upi_autopay', NOW).chargeable).toBe(true);
  });

  it('emandate is chargeable', () => {
    expect(assessInvoice(invoice(), 'emandate', NOW).chargeable).toBe(true);
  });

  it('always explains itself', () => {
    for (const method of ['upi_autopay', 'card', 'emandate']) {
      expect(assessInvoice(invoice(), method, NOW).explanation.length).toBeGreaterThan(30);
    }
  });
});

describe('the queue is ranked so the merchant works top down', () => {
  function item(over: Partial<QueueItem> = {}): QueueItem {
    return {
      invoice_id: 'inv_x',
      subscription_id: 'sub_x',
      customer_ref: 'cust_x',
      method: 'upi_autopay',
      amount_due_paise: 10000,
      charge_at: new Date('2026-09-03T00:00:00Z'),
      expected_paise: 5000,
      reason: 'because',
      short_url: null,
      chargeability: { chargeable: true, reason: 'chargeable', explanation: 'x' },
      ...over,
    };
  }

  it('puts chargeable invoices above ones nobody can charge', () => {
    const blocked = item({
      invoice_id: 'blocked',
      expected_paise: 999999,
      chargeability: { chargeable: false, reason: 'domestic_card', explanation: 'x' },
    });
    const ok = item({ invoice_id: 'ok', expected_paise: 1 });
    expect(rankQueue([blocked, ok])[0]!.invoice_id).toBe('ok');
  });

  it('ranks by expected value, highest first', () => {
    const low = item({ invoice_id: 'low', expected_paise: 100 });
    const high = item({ invoice_id: 'high', expected_paise: 900 });
    expect(rankQueue([low, high])[0]!.invoice_id).toBe('high');
  });

  it('breaks ties by charging the soonest first', () => {
    const later = item({ invoice_id: 'later', charge_at: new Date('2026-09-10T00:00:00Z') });
    const sooner = item({ invoice_id: 'sooner', charge_at: new Date('2026-09-02T00:00:00Z') });
    expect(rankQueue([later, sooner])[0]!.invoice_id).toBe('sooner');
  });

  it('does not mutate the input', () => {
    const list = [item({ invoice_id: 'a', expected_paise: 1 }), item({ invoice_id: 'b', expected_paise: 2 })];
    rankQueue(list);
    expect(list[0]!.invoice_id).toBe('a');
  });
});

function reader(responses: { ok?: boolean; status?: number; body?: unknown }[]) {
  const calls: { url: string; method: string }[] = [];
  let i = 0;
  const transport: Transport = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      text: async () => JSON.stringify(spec.body ?? {}),
    } as Response;
  };
  return { calls, reader: new InvoiceReader({ keyId: 'k', keySecret: 's', transport }) };
}

describe('the invoice reader', () => {
  it('fetches invoices for a subscription', async () => {
    const { calls, reader: r } = reader([{ body: { count: 1, items: [invoice()] } }]);
    const items = await r.invoicesFor('sub_1');
    expect(items).toHaveLength(1);
    expect(calls[0]!.url).toContain('/subscriptions/sub_1/invoices');
  });

  it('returns an empty list rather than undefined', async () => {
    const { reader: r } = reader([{ body: {} }]);
    expect(await r.invoicesFor('sub_1')).toEqual([]);
  });

  it('sends the invoice link, which is the one recovery action the API does allow', async () => {
    const { calls, reader: r } = reader([{ body: { success: true } }]);
    expect(await r.notify('inv_1', 'sms')).toBe(true);
    expect(calls[0]!.url).toContain('/invoices/inv_1/notify_by/sms');
    expect(calls[0]!.method).toBe('POST');
  });

  it('raises a typed error on failure rather than returning nothing', async () => {
    const { reader: r } = reader([{ ok: false, status: 404, body: { error: { code: 'X', description: 'not found' } } }]);
    await expect(r.invoicesFor('sub_missing')).rejects.toMatchObject({ name: 'RazorpayApiError', status: 404 });
  });
});
