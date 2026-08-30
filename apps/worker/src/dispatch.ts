import { evaluate } from '@mandate/core';
import type { Proposal } from '@mandate/core';
import { query } from '@mandate/db';
import { config } from './config.ts';
import { loadPolicyContext } from './context.ts';
import { shiftIfNeeded } from './holidays.ts';
import { execute } from './executor.ts';
import { sendOutreach } from './outreach/send.ts';
import type { OutreachProvider } from './outreach/provider.ts';
import type { Gateway } from './gateway.ts';
import { log } from './log.ts';

interface DueDecision {
  decision_id: number;
  subscription_id: string;
  rzp_subscription_id: string;
  cycle: Date;
  amount_paise: number;
  scheduled_for: Date;
  method: string;
  rationale: string | null;
  confidence: number | null;
  attempts_used: number;
}

const DUE_SQL = `
SELECT
  d.id AS decision_id, d.subscription_id, s.rzp_subscription_id, d.cycle,
  s.amount_paise, s.method, d.scheduled_for, d.rationale, d.confidence::float8 AS confidence,
  (SELECT count(*)::int FROM payment_attempt
    WHERE subscription_id = d.subscription_id AND cycle = d.cycle) AS attempts_used
FROM decision d
JOIN subscription s ON s.id = d.subscription_id
WHERE d.verdict = 'ALLOW'
  AND d.proposed_action = 'RETRY_SCHEDULED'
  AND d.executed_at IS NULL
  AND d.outcome IS NULL
  AND d.scheduled_for IS NOT NULL
  AND d.scheduled_for <= now()
  AND NOT EXISTS (SELECT 1 FROM execution_intent i WHERE i.decision_id = d.id)
ORDER BY d.scheduled_for
LIMIT $1
`;

async function recordRevocation(
  row: DueDecision,
  ruleId: string,
  explanation: string,
  verdict: 'DENY' | 'DEFER',
): Promise<void> {
  await query(
    `INSERT INTO decision (
       subscription_id, cycle, proposed_action, proposed_by, verdict, rule_id,
       proposed_for, rationale, explanation
     ) VALUES ($1,$2,'RETRY_SCHEDULED','recheck',$3,$4,$5,$6,$7)`,
    [
      row.subscription_id, row.cycle, verdict, ruleId, row.scheduled_for,
      row.rationale, `Re-checked before execution: ${explanation}`,
    ],
  );
  await query(
    `UPDATE decision SET outcome = 'revoked' WHERE id = $1`,
    [row.decision_id],
  );
}

const DUE_OUTREACH_SQL = `
SELECT d.id AS decision_id, d.subscription_id, d.cycle
  FROM decision d
  JOIN subscription s ON s.id = d.subscription_id
 WHERE d.verdict = 'ALLOW'
   AND d.proposed_action = 'REAUTH_OUTREACH'
   AND d.outcome IS NULL
   AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.decision_id = d.id)
 ORDER BY d.created_at
 LIMIT $1
`;

interface DueOutreach {
  decision_id: number;
  subscription_id: string;
  cycle: Date;
}

export async function dispatchOutreach(
  provider: OutreachProvider,
  now = new Date(),
): Promise<number> {
  const { rows } = await query<DueOutreach>(DUE_OUTREACH_SQL, [config.decideBatchSize]);

  for (const row of rows) {
    try {
      const result = await sendOutreach(
        { decision_id: row.decision_id, subscription_id: row.subscription_id, cycle: row.cycle, now },
        provider,
      );

      if (result.status === 'deferred') {
        log.info('outreach.deferred_quiet_hours', {
          decision_id: row.decision_id, until: result.until.toISOString(),
        });
        continue;
      }

      if (result.status === 'blocked') {
        await query(
          `UPDATE decision SET outcome = 'revoked', executed_at = clock_timestamp() WHERE id = $1`,
          [row.decision_id],
        );
        log.warn('outreach.blocked', { decision_id: row.decision_id, reason: result.reason });
        continue;
      }

      if (result.status === 'sent' || result.status === 'queued') {
        await query(
          `UPDATE decision SET executed_at = clock_timestamp(), outcome = $2 WHERE id = $1`,
          [row.decision_id, result.status === 'sent' ? 'contacted' : 'contact_queued'],
        );
      }

      log.info('outreach.dispatched', { decision_id: row.decision_id, status: result.status });
    } catch (err) {
      log.error('outreach.dispatch_failed', {
        decision_id: row.decision_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rows.length;
}

export async function dispatchDue(gateway: Gateway, now = new Date()): Promise<number> {
  const { rows } = await query<DueDecision>(DUE_SQL, [config.decideBatchSize]);

  for (const row of rows) {
    const attemptNumber = row.attempts_used + 1;

    try {
      const ctx = await loadPolicyContext(row.subscription_id, row.cycle, attemptNumber, now);

      if (!ctx) {
        await recordRevocation(row, 'R-HALT', 'subscription no longer exists', 'DENY');
        continue;
      }

      const proposal: Proposal = {
        subscription_id: row.subscription_id,
        action: 'RETRY_SCHEDULED',
        scheduled_for: row.scheduled_for.toISOString(),
        reason: row.rationale ?? '',
        confidence: row.confidence ?? 0,
      };

      const recheck = evaluate(proposal, ctx, { phase: 'execution' });

      if (recheck.verdict !== 'ALLOW') {
        await recordRevocation(row, recheck.rule_id, recheck.explanation, recheck.verdict);
        log.warn('dispatch.revoked', {
          decision_id: row.decision_id,
          rule_id: recheck.rule_id,
          verdict: recheck.verdict,
        });
        continue;
      }

      const shift = await shiftIfNeeded(row.scheduled_for, row.method);
      if (shift.shifted) {
        await query(
          `UPDATE decision SET scheduled_for = $2,
                  explanation = explanation || ' Shifted for a bank holiday: ' || $3
            WHERE id = $1`,
          [row.decision_id, shift.at, shift.reason ?? 'bank holiday'],
        );
      }

      const result = await execute(
        {
          decision_id: row.decision_id,
          subscription_id: row.subscription_id,
          rzp_subscription_id: row.rzp_subscription_id,
          cycle: row.cycle,
          attempt_number: attemptNumber,
          amount_paise: row.amount_paise,
          scheduled_for: shift.at,
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
