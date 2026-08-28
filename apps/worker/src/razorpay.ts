import { DuplicateReceiptError } from './gateway.ts';
import type { ChargeRequest, Gateway, OrderRef, PaymentRef } from './gateway.ts';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface RazorpayGatewayOptions {
  credentials: RazorpayCredentials;
  baseUrl?: string;
  transport?: Transport;
  tokenLookup: (subscriptionId: string) => Promise<{ token_id: string; customer_id: string } | null>;
}

export class RazorpayApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'RazorpayApiError';
    this.status = status;
    this.code = code;
  }
}

export class MissingTokenError extends Error {
  constructor(subscriptionId: string) {
    super(`No recurring token recorded for ${subscriptionId}`);
    this.name = 'MissingTokenError';
  }
}

interface RazorpayOrder {
  id: string;
  receipt: string | null;
  status: string;
}

interface RazorpayPayment {
  id: string;
  status: string;
  error_reason?: string | null;
}

function mapPaymentStatus(status: string): PaymentRef['status'] {
  switch (status) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'failed':
      return status;
    case 'refunded':
      return 'captured';
    default:
      return 'created';
  }
}

export class RazorpayGateway implements Gateway {
  private readonly credentials: RazorpayCredentials;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly tokenLookup: RazorpayGatewayOptions['tokenLookup'];

  constructor(options: RazorpayGatewayOptions) {
    this.credentials = options.credentials;
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.tokenLookup = options.tokenLookup;
  }

  private authHeader(): string {
    const raw = `${this.credentials.keyId}:${this.credentials.keySecret}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.transport(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new RazorpayApiError(response.status, null, `Unparseable response from ${path}`);
      }
    }

    if (!response.ok) {
      const error = (body as { error?: { code?: string; description?: string } } | null)?.error;
      const code = error?.code ?? null;
      const description = error?.description ?? `HTTP ${response.status}`;

      if (
        response.status === 400 &&
        (code === 'BAD_REQUEST_ERROR' || code === 'DUPLICATE_REQUEST_ERROR') &&
        /receipt/i.test(description)
      ) {
        throw new DuplicateReceiptError(description);
      }
      throw new RazorpayApiError(response.status, code, description);
    }

    return body as T;
  }

  async createOrderAndCharge(req: ChargeRequest): Promise<{ order: OrderRef; payment: PaymentRef | null }> {
    const token = await this.tokenLookup(req.subscription_id);
    if (!token) throw new MissingTokenError(req.subscription_id);

    const order = await this.call<RazorpayOrder>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: req.amount_paise,
        currency: 'INR',
        payment_capture: true,
        receipt: req.receipt,
        notification: {
          token_id: token.token_id,
          payment_after: Math.floor(req.scheduled_for.getTime() / 1000),
        },
      }),
    });

    const payment = await this.call<RazorpayPayment>('/payments/create/recurring', {
      method: 'POST',
      body: JSON.stringify({
        amount: req.amount_paise,
        currency: 'INR',
        order_id: order.id,
        customer_id: token.customer_id,
        token: token.token_id,
        recurring: true,
      }),
    });

    return {
      order: { id: order.id, receipt: order.receipt ?? req.receipt },
      payment: { id: payment.id, status: mapPaymentStatus(payment.status), error_reason: payment.error_reason ?? null },
    };
  }

  async findOrderByReceipt(receipt: string) {
    const list = await this.call<{ count: number; items: RazorpayOrder[] }>(
      `/orders?receipt=${encodeURIComponent(receipt)}`,
      { method: 'GET' },
    );

    const order = list.items?.[0];
    if (!order) return null;

    const payments = await this.call<{ count: number; items: RazorpayPayment[] }>(
      `/orders/${encodeURIComponent(order.id)}/payments`,
      { method: 'GET' },
    );

    return {
      order: { id: order.id, receipt: order.receipt ?? receipt },
      payments: (payments.items ?? []).map((p) => ({
        id: p.id,
        status: mapPaymentStatus(p.status),
        error_reason: p.error_reason ?? null,
      })),
    };
  }
}
