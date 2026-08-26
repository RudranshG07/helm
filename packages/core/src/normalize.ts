import type { Method } from './types.ts';

export interface RazorpayEvent {
  event?: string;
  account_id?: string;
  contains?: string[];
  payload?: {
    subscription?: { entity?: Record<string, unknown> };
    payment?: { entity?: Record<string, unknown> };
  };
  created_at?: number;
}

export interface NormalizedSubscription {
  rzp_subscription_id: string;
  customer_ref: string;
  method: Method;
  amount_paise: number;
  status: string;
  current_start: Date | null;
  current_end: Date | null;
  charge_at: Date | null;
  mandate_expiry_at: Date | null;
  cycle_interval: string | null;
}

export interface NormalizedAttempt {
  rzp_payment_id: string | null;
  rzp_order_id: string | null;
  attempted_at: Date;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'unknown';
  amount_paise: number;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  issuer: string | null;
  bank: string | null;
}

export interface NormalizedEvent {
  event: string;
  subscription: NormalizedSubscription | null;
  attempt: NormalizedAttempt | null;
}

const METHOD_MAP: Record<string, Method> = {
  upi: 'upi_autopay',
  upi_autopay: 'upi_autopay',
  card: 'card',
  emandate: 'emandate',
  nach: 'emandate',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

function epoch(v: unknown): Date | null {
  const n = int(v);
  return n === null || n <= 0 ? null : new Date(n * 1000);
}

function toMethod(v: unknown): Method | null {
  const key = str(v)?.toLowerCase();
  return key ? METHOD_MAP[key] ?? null : null;
}

function paymentStatus(v: unknown): NormalizedAttempt['status'] {
  const s = str(v);
  switch (s) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'failed':
      return s;
    default:
      return 'unknown';
  }
}

export function normalize(evt: RazorpayEvent): NormalizedEvent {
  const event = str(evt?.event) ?? 'unknown';
  const sub = evt?.payload?.subscription?.entity;
  const pay = evt?.payload?.payment?.entity;

  const method =
    toMethod(pay?.['method']) ?? toMethod(sub?.['payment_method']) ?? null;

  const subscription: NormalizedSubscription | null =
    sub && str(sub['id'])
      ? {
          rzp_subscription_id: str(sub['id'])!,
          customer_ref: str(sub['customer_id']) ?? str(sub['id'])!,
          method: method ?? 'card',
          amount_paise: int(pay?.['amount']) ?? 0,
          status: str(sub['status']) ?? 'unknown',
          current_start: epoch(sub['current_start']),
          current_end: epoch(sub['current_end']),
          charge_at: epoch(sub['charge_at']),
          mandate_expiry_at: epoch(sub['expire_by']) ?? epoch(sub['end_at']),
          cycle_interval: str(sub['plan_id']),
        }
      : null;

  const attempt: NormalizedAttempt | null = pay
    ? {
        rzp_payment_id: str(pay['id']),
        rzp_order_id: str(pay['order_id']),
        attempted_at: epoch(pay['created_at']) ?? epoch(evt?.created_at) ?? new Date(0),
        status: paymentStatus(pay['status']),
        amount_paise: int(pay['amount']) ?? 0,
        error_code: str(pay['error_code']),
        error_description: str(pay['error_description']),
        error_source: str(pay['error_source']),
        error_step: str(pay['error_step']),
        error_reason: str(pay['error_reason']),
        issuer: str(pay['bank']) ?? str((pay['acquirer_data'] as Record<string, unknown>)?.['bank']),
        bank: str(pay['bank']),
      }
    : null;

  return { event, subscription, attempt };
}
