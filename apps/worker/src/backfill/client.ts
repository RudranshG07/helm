import { RazorpayApiError } from '../razorpay.ts';
import type { Transport } from '../razorpay.ts';

export interface RazorpayPaymentRecord {
  id: string;
  order_id: string | null;
  invoice_id: string | null;
  customer_id: string | null;
  amount: number;
  status: string;
  method: string | null;
  created_at: number;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  bank: string | null;
}

export interface ReaderOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  transport?: Transport;
  pageSize?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_PAGE_SIZE = 100;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class RazorpayReader {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;

  public requests = 0;
  public retries = 0;

  constructor(options: ReaderOptions) {
    this.keyId = options.keyId;
    this.keySecret = options.keySecret;
    this.baseUrl = options.baseUrl ?? 'https://api.razorpay.com/v1';
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? MAX_PAGE_SIZE));
    this.maxPages = options.maxPages ?? 500;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call<T>(path: string, attempt = 0): Promise<T> {
    this.requests += 1;
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`, 'utf8').toString('base64');

    const response = await this.transport(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    });

    const text = await response.text();

    if (!response.ok) {
      if (RETRYABLE.has(response.status) && attempt < 4) {
        this.retries += 1;
        await this.sleep(2 ** attempt * 500);
        return this.call<T>(path, attempt + 1);
      }
      let code: string | null = null;
      let description = `HTTP ${response.status}`;
      try {
        const body = JSON.parse(text) as { error?: { code?: string; description?: string } };
        code = body.error?.code ?? null;
        description = body.error?.description ?? description;
      } catch {
        /* keep the status-derived message */
      }
      throw new RazorpayApiError(response.status, code, description);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RazorpayApiError(response.status, null, `Unparseable response from ${path}`);
    }
  }

  async *payments(from: Date, to: Date): AsyncGenerator<RazorpayPaymentRecord[]> {
    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.floor(to.getTime() / 1000);
    let skip = 0;

    for (let page = 0; page < this.maxPages; page += 1) {
      const path =
        `/payments?from=${fromSec}&to=${toSec}&count=${this.pageSize}&skip=${skip}`;
      const body = await this.call<{ count: number; items: RazorpayPaymentRecord[] }>(path);
      const items = body.items ?? [];

      if (items.length === 0) return;
      yield items;

      if (items.length < this.pageSize) return;
      skip += items.length;
    }
  }
}
