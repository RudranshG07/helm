import type { FastifyInstance } from 'fastify';
import { buildDecisionTrace } from '@mandate/worker/trace/decision';
import { buildProof } from '@mandate/worker/proof/build';
import { buildDocs } from '@mandate/worker/docs/build';
import {
  atRisk,
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
  app.get('/api/overview', async () => overview());

  app.get<{ Querystring: { limit?: string } }>('/api/at-risk', async (request) => {
    const limit = Math.min(500, Number(request.query.limit ?? 100) || 100);
    return { subscriptions: await atRisk(limit) };
  });

  app.get<{ Params: { id: string } }>('/api/subscriptions/:id', async (request, reply) => {
    const detail = await subscriptionDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: 'not found' });
    return detail;
  });

  app.get('/api/declines', async () => ({
    distribution: await declineDistribution(),
    unmapped: await unmappedCodes(),
  }));

  app.get('/api/proof', async () => buildProof());

  app.get('/api/docs', async () => buildDocs());

  app.get<{ Params: { id: string } }>('/api/decisions/:id/trace', async (request, reply) => {
    if (!/^\d+$/.test(request.params.id)) {
      return reply.code(400).send({ error: 'decision id must be numeric' });
    }
    const trace = await buildDecisionTrace(request.params.id);
    if (!trace) return reply.code(404).send({ error: 'unknown decision' });
    return trace;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/outreach', async (request) => {
    const limit = Math.min(500, Number(request.query.limit ?? 100) || 100);
    return {
      outreach: await outreachLog(limit),
      funnel: await outreachFunnel(),
    };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/decisions', async (request) => {
    const limit = Math.min(1000, Number(request.query.limit ?? 200) || 200);
    return {
      decisions: await decisionLog(limit),
      denials_by_rule: await denialsByRule(),
    };
  });
}
