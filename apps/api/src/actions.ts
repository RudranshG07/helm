import type { FastifyInstance } from 'fastify';
import { evaluate } from '@mandate/core';
import type { Proposal } from '@mandate/core';
import { loadPolicyContext } from '@mandate/worker/context';
import { query } from '@mandate/db';
import { requireMerchant } from './session.ts';

export const MERCHANT_ACTIONS = ['RETRY_SCHEDULED', 'REAUTH_OUTREACH', 'STOP'] as const;
export type MerchantAction = (typeof MERCHANT_ACTIONS)[number];

const WHY: Record<MerchantAction, string> = {
  RETRY_SCHEDULED: 'The merchant asked for this to be charged now.',
  REAUTH_OUTREACH: 'The merchant asked the customer to be contacted for a new mandate.',
  STOP: 'The merchant asked for this mandate to be left alone.',
};

interface MandateRow {
  cycle: Date;
  attempts_used: number;
}

export function registerActionRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { action?: string; note?: string } }>(
    '/api/mandates/:id/action',
    async (request, reply) => {
      const merchant = await requireMerchant(request, reply);
      if (merchant === null) return reply;

      const action = (request.body?.action ?? '') as MerchantAction;
      if (!MERCHANT_ACTIONS.includes(action)) {
        return reply.code(400).send({
          error: `Pick one of ${MERCHANT_ACTIONS.join(', ')}.`,
        });
      }

      const { rows } = await query<MandateRow>(
        `SELECT COALESCE(s.current_start, to_timestamp(0)) AS cycle,
                (SELECT count(*)::int FROM payment_attempt pa
                  WHERE pa.subscription_id = s.id
                    AND pa.cycle = COALESCE(s.current_start, to_timestamp(0))) AS attempts_used
           FROM subscription s
          WHERE s.id = $1 AND s.merchant_id = $2`,
        [request.params.id, merchant],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'not found' });

      const now = new Date();
      const context = await loadPolicyContext(
        request.params.id, row.cycle, row.attempts_used + 1, now,
      );
      if (!context) return reply.code(404).send({ error: 'not found' });

      const proposal: Proposal = {
        subscription_id: request.params.id,
        action,
        reason: request.body?.note?.trim() || WHY[action],
        confidence: 1,
        ...(action === 'RETRY_SCHEDULED' ? { scheduled_for: now.toISOString() } : {}),
      };

      const verdict = evaluate(proposal, context);

      const { rows: written } = await query<{ id: string }>(
        `INSERT INTO decision (
           subscription_id, cycle, proposed_action, proposed_by, confidence,
           verdict, rule_id, scheduled_for, proposed_for, rationale, explanation
         ) VALUES ($1,$2,$3,'merchant',1,$4,$5,$6,$7,$8,$9)
         RETURNING id::text AS id`,
        [
          request.params.id, row.cycle, action,
          verdict.verdict, verdict.rule_id,
          verdict.scheduled_for ?? null, proposal.scheduled_for ?? null,
          proposal.reason, verdict.explanation ?? null,
        ],
      );

      app.log.info({
        event: 'merchant.action',
        merchant_id: merchant,
        subscription_id: request.params.id,
        action,
        verdict: verdict.verdict,
        rule_id: verdict.rule_id,
      });

      return {
        decision_id: written[0]?.id ?? null,
        action,
        verdict: verdict.verdict,
        rule_id: verdict.rule_id,
        explanation: verdict.explanation ?? null,
        scheduled_for: verdict.scheduled_for ?? null,
      };
    },
  );
}
