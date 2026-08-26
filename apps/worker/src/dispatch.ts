import { query } from '@mandate/db';
import { config } from './config.ts';
import { execute } from './executor.ts';
import type { Gateway } from './gateway.ts';
import { log } from './log.ts';

interface DueDecision {
  decision_id: number;
  subscription_id: string;
  rzp_subscription_id: string;
  cycle: Date;
  amount_paise: number;
  scheduled_for: Date;
  attempts_used: number;
}

const DUE_SQL = `
SELECT
  d.id AS decision_id, d.subscription_id, s.rzp_subscription_id, d.cycle,
  s.amount_paise, d.scheduled_for,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = d.subscription_id AND cycle = d.cycle) AS attempts_used
FROM decision d
JOIN subscription s ON s.id = d.subscription_id
WHERE d.verdict = 'ALLOW'
  AND d.proposed_action = 'RETRY_SCHEDULED'
  AND d.executed_at IS NULL
  AND d.scheduled_for IS NOT NULL
  AND d.scheduled_for <= now()
  AND NOT EXISTS (
    SELECT 1 FROM execution_intent i WHERE i.decision_id = d.id
  )
ORDER BY d.scheduled_for
LIMIT $1
`;

export async function dispatchDue(gateway: Gateway, now = new Date()): Promise<number> {
  const { rows } = await query<DueDecision>(DUE_SQL, [config.decideBatchSize]);

  for (const row of rows) {
    try {
      const result = await execute(
        {
          decision_id: row.decision_id,
          subscription_id: row.subscription_id,
          rzp_subscription_id: row.rzp_subscription_id,
          cycle: row.cycle,
          attempt_number: row.attempts_used + 1,
          amount_paise: row.amount_paise,
          scheduled_for: row.scheduled_for ?? now,
        },
        { gateway },
      );
      log.info('dispatch.done', { decision_id: row.decision_id, status: result.status });
    } catch (err) {
      log.error('dispatch.failed', {
        decision_id: row.decision_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rows.length;
}
