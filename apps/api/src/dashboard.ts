import type { FastifyInstance } from 'fastify';
import { buildDecisionTrace } from '@mandate/worker/trace/decision';
import { buildDocs } from '@mandate/worker/docs/build';
import { buildProof } from '@mandate/worker/proof/build';
import { publicTotals } from './public.ts';
import { requireMerchant } from './session.ts';
import {
  atRisk,
  decisionBelongsTo,
  decisionLog,
  declineDistribution,
  denialsByRule,
  overview,
  subscriptionDetail,
  outreachFunnel,
  outreachLog,
  unmappedCodes,
} from './queries.ts';

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get('/api/public', async () => publicTotals());

  app.get('/api/docs', async () => buildDocs());

  app.get('/api/proof', async () => buildProof());

  app.get('/api/overview', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    return overview(merchant);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/at-risk', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const limit = Math.min(500, Number(request.query.limit ?? 100) || 100);
    return { subscriptions: await atRisk(merchant, limit) };
  });

  app.get<{ Params: { id: string } }>('/api/subscriptions/:id', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const detail = await subscriptionDetail(merchant, request.params.id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.get('/api/declines', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    return {
      distribution: await declineDistribution(merchant),
      unmapped: await unmappedCodes(merchant),
    };
  });

  app.get<{ Params: { id: string } }>('/api/decisions/:id/trace', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    if (!/^\d+$/.test(request.params.id)) {
      return reply.code(400).send({ error: 'decision id must be numeric' });
    }
    if (!(await decisionBelongsTo(merchant, request.params.id))) {
      return reply.code(404).send({ error: 'unknown decision' });
    }
    const trace = await buildDecisionTrace(request.params.id);
    if (!trace) return reply.code(404).send({ error: 'unknown decision' });
    return trace;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/outreach', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const limit = Math.min(500, Number(request.query.limit ?? 100) || 100);
    return {
      outreach: await outreachLog(merchant, limit),
      funnel: await outreachFunnel(merchant),
    };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/decisions', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const limit = Math.min(1000, Number(request.query.limit ?? 200) || 200);
    return {
      decisions: await decisionLog(merchant, limit),
      denials_by_rule: await denialsByRule(merchant),
    };
  });
}
