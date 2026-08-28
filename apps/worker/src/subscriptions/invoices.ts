import { RazorpayApiError } from '../razorpay.ts';
import type { Transport } from '../razorpay.ts';

export interface InvoiceRecord {
  id: string;
  subscription_id: string | null;
  customer_id: string | null;
  status: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  issued_at: number | null;
  expire_by: number | null;
  short_url: string | null;
}

export interface InvoiceReaderOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  transport?: Transport;
}

export class InvoiceReader {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(options: InvoiceReaderOptions) {
    this.keyId = options.keyId;
    this.keySecret = options.keySecret;
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`, 'utf8').toString('base64');
    const response = await this.transport(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      let code: string | null = null;
      let description = `HTTP ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: { code?: string; description?: string } };
        code = body.error?.code ?? null;
        description = body.error?.description ?? description;
      } catch {
        /* status-derived message stands */
      }
      throw new RazorpayApiError(response.status, code, description);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RazorpayApiError(response.status, null, `Unparseable response from ${path}`);
    }
  }

  async invoicesFor(subscriptionId: string): Promise<InvoiceRecord[]> {
    const body = await this.call<{ count: number; items: InvoiceRecord[] }>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/invoices`,
    );
    return body.items ?? [];
  }

  async notify(invoiceId: string, medium: 'sms' | 'email'): Promise<boolean> {
    const body = await this.call<{ success: boolean }>(
      `/invoices/${encodeURIComponent(invoiceId)}/notify_by/${medium}`,
      { method: 'POST' },
    );
    return body.success === true;
  }
}

export type ChargeableReason =
  | 'chargeable'
  | 'not_issued'
  | 'already_paid'
  | 'expired'
  | 'domestic_card';

export interface Chargeability {
  chargeable: boolean;
  reason: ChargeableReason;
  explanation: string;
}

export function assessInvoice(
  invoice: InvoiceRecord,
  method: string,
  now: Date,
): Chargeability {
  if (method === 'card') {
    return {
      chargeable: false,
      reason: 'domestic_card',
      explanation:
        'Razorpay does not support manually charging a domestic card, so this invoice cannot be ' +
        'attempted by anyone, from the dashboard or otherwise.',
    };
  }
  if (invoice.status !== 'issued') {
    return {
      chargeable: false,
      reason: invoice.amount_due === 0 ? 'already_paid' : 'not_issued',
      explanation: `Invoice is ${invoice.status}; only an issued invoice can be charged.`,
    };
  }
  if (invoice.amount_due <= 0) {
    return {
      chargeable: false,
      reason: 'already_paid',
      explanation: 'Nothing is outstanding on this invoice.',
    };
  }
  if (invoice.expire_by && invoice.expire_by * 1000 <= now.getTime()) {
    return {
      chargeable: false,
      reason: 'expired',
      explanation: 'The invoice has expired and can no longer be charged.',
    };
  }
  return {
    chargeable: true,
    reason: 'chargeable',
    explanation:
      'Issued, outstanding, and on a method that supports a manual charge. A manual charge does ' +
      'not consume the subscription retry budget.',
  };
}

export interface QueueItem {
  invoice_id: string;
  subscription_id: string;
  customer_ref: string;
  method: string;
  amount_due_paise: number;
  charge_at: Date | null;
  expected_paise: number;
  reason: string;
  short_url: string | null;
  chargeability: Chargeability;
}

export function rankQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (a.chargeability.chargeable !== b.chargeability.chargeable) {
      return a.chargeability.chargeable ? -1 : 1;
    }
    if (b.expected_paise !== a.expected_paise) return b.expected_paise - a.expected_paise;
    const at = a.charge_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = b.charge_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
}
