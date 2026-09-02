import { deconflict, findCollisions } from '@mandate/core';
import type { ScheduledDebit } from '@mandate/core';
import { query, withTransaction } from '@mandate/db';
import { log } from '../log.ts';

export interface DeconflictSummary {
  considered: number;
  customers: number;
  collisions_before: number;
  collisions_after: number;
  moved: number;
  unresolvable: number;
}

interface PendingRow {
  id: string;
  merchant_id: string;
  customer_key: string;
  amount_paise: string;
  scheduled_for: Date;
  cycle_end: Date | null;
}

const PENDING_SQL = `
  SELECT d.id::text AS id,
         s.merchant_id,
         COALESCE(s.customer_key, s.customer_ref) AS customer_key,
         s.amount_paise::text AS amount_paise,
         d.scheduled_for,
         s.current_end AS cycle_end
    FROM decision d
    JOIN subscription s ON s.id = d.subscription_id
    JOIN merchant m ON m.id = s.merchant_id
   WHERE d.verdict = 'ALLOW'
     AND d.proposed_action = 'RETRY_SCHEDULED'
     AND d.executed_at IS NULL
     AND d.outcome IS NULL
     AND d.scheduled_for IS NOT NULL
     AND d.scheduled_for > $1
     AND d.scheduled_for < $1 + interval '14 days'
     AND m.cross_merchant_signals
   ORDER BY d.scheduled_for`;

export async function deconflictScheduled(now = new Date()): Promise<DeconflictSummary> {
  const { rows } = await query<PendingRow>(PENDING_SQL, [now]);

  const empty: DeconflictSummary = {
    considered: rows.length,
    customers: 0,
    collisions_before: 0,
    collisions_after: 0,
    moved: 0,
    unresolvable: 0,
  };

  if (rows.length < 2) return empty;

  const debits: ScheduledDebit[] = rows.map((r) => ({
    id: r.id,
    merchant_id: r.merchant_id,
    customer_key: r.customer_key,
    amount_paise: Number(r.amount_paise),
    at: r.scheduled_for,
    earliest: now,
    latest: r.cycle_end && r.cycle_end < new Date(r.scheduled_for.getTime() + 5 * 86_400_000)
      ? r.cycle_end
      : new Date(r.scheduled_for.getTime() + 5 * 86_400_000),
  }));

  empty.customers = new Set(debits.map((d) => d.customer_key)).size;
  const before = findCollisions(debits);
  if (before.length === 0) {
    return { ...empty, collisions_before: 0, collisions_after: 0 };
  }

  const result = deconflict(debits);
  const moves = result.assignments.filter((a) => a.moved);

  if (moves.length > 0) {
    await withTransaction(async (client) => {
      for (const move of moves) {
        await client.query(
          `UPDATE decision
              SET scheduled_for = $2,
                  explanation = explanation || ' Spread to avoid a same-account collision: ' || $3
            WHERE id = $1 AND executed_at IS NULL AND outcome IS NULL`,
          [move.id, move.assigned_at, move.reason],
        );
      }
    });
  }

  log.info('deconflict.pass', {
    considered: rows.length,
    collisions_before: result.collisions_before,
    collisions_after: result.collisions_after,
    moved: moves.length,
  });

  return {
    considered: rows.length,
    customers: empty.customers,
    collisions_before: result.collisions_before,
    collisions_after: result.collisions_after,
    moved: moves.length,
    unresolvable: result.unresolvable.length,
  };
}
