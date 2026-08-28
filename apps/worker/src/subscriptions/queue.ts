import { SuccessModel } from '@mandate/core';
import { query } from '@mandate/db';
import { buildPlan, loadOutcomes } from '../planner.ts';
import { assessInvoice, rankQueue } from './invoices.ts';
import type { InvoiceReader, InvoiceRecord, QueueItem } from './invoices.ts';
import { log } from '../log.ts';

interface SubscriptionRow {
  id: string;
  rzp_subscription_id: string;
  customer_ref: string;
  method: string;
  amount_paise: number;
  cycle_end: Date | null;
  mandate_expiry_at: Date | null;
  attempts_used: number;
  last_failure_at: Date | null;
  last_bucket: string | null;
  issuer: string | null;
}

const AT_RISK_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (subscription_id) * FROM mandate_health
   ORDER BY subscription_id, scored_at DESC, id DESC
)
SELECT
  s.id, s.rzp_subscription_id, s.customer_ref, s.method, s.amount_paise,
  s.current_end AS cycle_end, s.mandate_expiry_at,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = s.id
      AND cycle = COALESCE(s.current_start, to_timestamp(0))
      AND counts_against_budget) AS attempts_used,
  a.attempted_at AS last_failure_at, a.bucket AS last_bucket, a.issuer
FROM latest h
JOIN subscription s ON s.id = h.subscription_id
JOIN merchant m ON m.id = s.merchant_id
LEFT JOIN LATERAL (
  SELECT attempted_at, bucket, issuer FROM payment_attempt
   WHERE subscription_id = s.id AND status = 'failed'
   ORDER BY attempted_at DESC LIMIT 1
) a ON TRUE
WHERE h.risk_band <> 'healthy'
  AND m.integration = 'subscriptions'
  AND ($1::text IS NULL OR s.merchant_id = $1)
ORDER BY s.amount_paise DESC
LIMIT $2
`;

export interface QueueResult {
  items: QueueItem[];
  subscriptions_examined: number;
  invoices_seen: number;
  chargeable: number;
  blocked_domestic_card: number;
}

export async function buildChargeQueue(
  reader: InvoiceReader,
  merchantId?: string,
  now = new Date(),
  limit = 200,
): Promise<QueueResult> {
  const { rows } = await query<SubscriptionRow>(AT_RISK_SQL, [merchantId ?? null, limit]);
  const model = new SuccessModel(await loadOutcomes(merchantId));

  const result: QueueResult = {
    items: [],
    subscriptions_examined: rows.length,
    invoices_seen: 0,
    chargeable: 0,
    blocked_domestic_card: 0,
  };

  for (const row of rows) {
    let invoices: InvoiceRecord[];
    try {
      invoices = await reader.invoicesFor(row.rzp_subscription_id);
    } catch (err) {
      log.error('queue.invoice_fetch_failed', {
        subscription_id: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    result.invoices_seen += invoices.length;

    for (const invoice of invoices) {
      const chargeability = assessInvoice(invoice, row.method, now);
      if (chargeability.reason === 'domestic_card') result.blocked_domestic_card += 1;
      if (!chargeability.chargeable && chargeability.reason !== 'domestic_card') continue;
      if (chargeability.chargeable) result.chargeable += 1;

      const plan = buildPlan(
        {
          subscription_id: row.id,
          bucket: (row.last_bucket ?? 'UNKNOWN') as never,
          issuer: row.issuer,
          method: row.method as never,
          amount_paise: invoice.amount_due,
          attempts_remaining: Math.max(0, 4 - row.attempts_used),
          days_to_halt: row.cycle_end
            ? Math.max(0, Math.floor((row.cycle_end.getTime() - now.getTime()) / 86_400_000))
            : 14,
          last_failure_at: row.last_failure_at ?? now,
          reauth_available: false,
          remaining_cycles: 6,
          now,
        },
        model,
      );

      result.items.push({
        invoice_id: invoice.id,
        subscription_id: row.id,
        customer_ref: row.customer_ref,
        method: row.method,
        amount_due_paise: invoice.amount_due,
        charge_at: plan.at,
        expected_paise: plan.expected_paise,
        reason: plan.reason,
        short_url: invoice.short_url,
        chargeability,
      });
    }
  }

  result.items = rankQueue(result.items);
  return result;
}
