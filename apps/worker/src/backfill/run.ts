import { classify } from '@mandate/core';
import type { Method } from '@mandate/core';
import { withTransaction } from '@mandate/db';
import { log } from '../log.ts';
import type { RazorpayPaymentRecord, RazorpayReader } from './client.ts';

export interface BackfillResult {
  pages: number;
  payments_seen: number;
  attempts_inserted: number;
  attempts_duplicate: number;
  subscriptions_touched: number;
  requests: number;
  retries: number;
  skipped_no_group: number;
}

const METHOD_MAP: Record<string, Method> = {
  upi: 'upi_autopay',
  card: 'card',
  emandate: 'emandate',
  nach: 'emandate',
  netbanking: 'emandate',
};

function toMethod(raw: string | null): Method {
  return (raw && METHOD_MAP[raw.toLowerCase()]) || 'upi_autopay';
}

function toStatus(raw: string): 'created' | 'authorized' | 'captured' | 'failed' | 'unknown' {
  switch (raw) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'failed':
      return raw;
    case 'refunded':
      return 'captured';
    default:
      return 'unknown';
  }
}

function cycleOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export async function backfill(
  reader: RazorpayReader,
  merchantId: string,
  from: Date,
  to: Date,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    pages: 0,
    payments_seen: 0,
    attempts_inserted: 0,
    attempts_duplicate: 0,
    subscriptions_touched: 0,
    requests: 0,
    retries: 0,
    skipped_no_group: 0,
  };

  const touched = new Set<string>();

  for await (const page of reader.payments(from, to)) {
    result.pages += 1;
    result.payments_seen += page.length;
    await persist(page, merchantId, result, touched);
    log.info('backfill.page', { page: result.pages, payments: page.length });
  }

  result.subscriptions_touched = touched.size;
  result.requests = reader.requests;
  result.retries = reader.retries;
  return result;
}

async function persist(
  page: RazorpayPaymentRecord[],
  merchantId: string,
  result: BackfillResult,
  touched: Set<string>,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO merchant (id, name, mode) VALUES ($1, $1, 'test')
       ON CONFLICT (id) DO NOTHING`,
      [merchantId],
    );

    for (const p of page) {
      const group = p.invoice_id ?? p.order_id;
      if (!group) {
        result.skipped_no_group += 1;
        continue;
      }

      const subscriptionId = `${merchantId}:${group}`;
      const attemptedAt = new Date(p.created_at * 1000);
      const method = toMethod(p.method);

      await client.query(
        `INSERT INTO subscription (
           id, merchant_id, rzp_subscription_id, customer_ref, method,
           amount_paise, status, current_start
         ) VALUES ($1,$2,$3,$4,$5,GREATEST($6,1),'unknown',$7)
         ON CONFLICT (id) DO UPDATE SET
           amount_paise = GREATEST(subscription.amount_paise, EXCLUDED.amount_paise),
           updated_at = now()`,
        [
          subscriptionId, merchantId, group,
          p.customer_id ?? group, method, p.amount, cycleOf(attemptedAt),
        ],
      );
      touched.add(subscriptionId);

      const classification = classify(p, method);
      const rows = await client.query(
        `INSERT INTO payment_attempt (
           subscription_id, rzp_payment_id, rzp_order_id, cycle, attempted_at, status,
           amount_paise, error_code, error_description, error_source, error_step, error_reason,
           issuer, bank, initiated_by, source, bucket, taxonomy_version, counts_against_budget
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'razorpay_default','backfill',$14,$15,FALSE)
         ON CONFLICT (rzp_payment_id) WHERE rzp_payment_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          subscriptionId, p.id, p.order_id, cycleOf(attemptedAt), attemptedAt, toStatus(p.status),
          p.amount, p.error_code, p.error_description, p.error_source, p.error_step, p.error_reason,
          p.bank, classification.bucket, classification.taxonomy_version,
        ],
      );

      if ((rows.rowCount ?? 0) > 0) result.attempts_inserted += 1;
      else result.attempts_duplicate += 1;
    }
  });
}
