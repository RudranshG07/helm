import { RazorpayApiError } from '../razorpay.ts';
import type { Transport } from '../razorpay.ts';

export interface SetupOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  transport?: Transport;
}

export interface PlanRecord { id: string; item: { name: string; amount: number } }
export interface SubscriptionRecord { id: string; status: string; short_url: string | null }

export class RazorpaySetup {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(options: SetupOptions) {
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
        /* keep status message */
      }
      throw new RazorpayApiError(response.status, code, description);
    }
    return JSON.parse(text) as T;
  }

  async whoami(): Promise<{ reachable: boolean; problem: string | null }> {
    try {
      await this.call('/payments?count=1');
      return { reachable: true, problem: null };
    } catch (err) {
      return {
        reachable: false,
        problem: err instanceof RazorpayApiError
          ? `${err.status}: ${err.message}`
          : (err as Error).message,
      };
    }
  }

  async createPlan(name: string, amountPaise: number): Promise<PlanRecord> {
    return this.call<PlanRecord>('/plans', {
      method: 'POST',
      body: JSON.stringify({
        period: 'monthly',
        interval: 1,
        item: { name, amount: amountPaise, currency: 'INR', description: `${name} monthly` },
        notes: { created_by: 'helm_setup' },
      }),
    });
  }

  async createSubscription(planId: string, totalCount = 12): Promise<SubscriptionRecord> {
    return this.call<SubscriptionRecord>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        plan_id: planId,
        total_count: totalCount,
        customer_notify: 0,
        notes: { created_by: 'helm_setup' },
      }),
    });
  }

  async listSubscriptions(count = 100): Promise<{ items: SubscriptionRecord[] }> {
    return this.call<{ items: SubscriptionRecord[] }>(`/subscriptions?count=${count}`);
  }

  async registerWebhook(url: string, secret: string): Promise<{ id: string; url: string }> {
    return this.call<{ id: string; url: string }>('/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url,
        secret,
        alert_email: undefined,
        events: [
          'subscription.pending', 'subscription.halted', 'subscription.charged',
          'subscription.activated', 'subscription.cancelled',
          'payment.failed', 'payment.captured',
          'payment.downtime.started', 'payment.downtime.resolved',
        ],
      }),
    });
  }
}

export interface SetupPlan {
  name: string;
  amount_paise: number;
  count: number;
}

export const DEFAULT_MANDATES: SetupPlan[] = [
  { name: 'Gym membership', amount_paise: 149900, count: 4 },
  { name: 'Tiffin service', amount_paise: 49900, count: 4 },
  { name: 'Coaching fees', amount_paise: 499900, count: 3 },
  { name: 'Streaming', amount_paise: 19900, count: 4 },
];
