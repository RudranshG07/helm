import { requireMerchant } from './session.ts';
import { buildReport, reportIndex } from '@mandate/worker/reports/live';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';



export function registerControlRoutes(app: FastifyInstance): void {
  app.get('/api/merchants', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;
    const { rows } = await query(
      `SELECT m.id, m.name, m.mode, m.integration, m.write_enabled, m.cross_merchant_signals,
              m.consent_signed_at,
              (SELECT count(*)::int FROM subscription s WHERE s.merchant_id = m.id) AS subscriptions
         FROM merchant m WHERE m.id = $1`,
      [merchant],
    );
    return { merchants: rows };
  });

  app.get('/api/control', async () => {
    const { rows } = await query<{
      kill_switch: boolean; kill_switch_reason: string | null; updated_at: Date;
    }>(`SELECT kill_switch, kill_switch_reason, updated_at FROM control_flags WHERE id = 1`);
    return {
      ...rows[0],
      dry_run: process.env['DRY_RUN'] !== 'false',
      mode: process.env['RAZORPAY_MODE'] ?? 'test',
      release_requires_token: Boolean(process.env['KILL_SWITCH_RELEASE_TOKEN']),
    };
  });

  app.post<{ Body: { engaged?: boolean; reason?: string; token?: string } }>(
    '/api/control/kill-switch',
    async (request, reply) => {
      if ((await requireMerchant(request, reply)) === null) return reply;
      const engaged = request.body?.engaged !== false;

      if (!engaged) {
        const required = process.env['KILL_SWITCH_RELEASE_TOKEN'];
        if (!required) {
          return reply.code(403).send({
            error: 'Releasing the kill switch requires KILL_SWITCH_RELEASE_TOKEN to be configured.',
          });
        }
        if (request.body?.token !== required) {
          app.log.warn({ event: 'killswitch.release_denied' });
          return reply.code(403).send({ error: 'Invalid release token.' });
        }
      }

      await query(
        `UPDATE control_flags
            SET kill_switch = $1,
                kill_switch_reason = $2,
                updated_at = clock_timestamp()
          WHERE id = 1`,
        [engaged, engaged ? (request.body?.reason ?? 'engaged from dashboard') : null],
      );

      app.log.warn({ event: engaged ? 'killswitch.engaged' : 'killswitch.released' });
      return { kill_switch: engaged };
    },
  );

  app.get('/api/reports', async () => ({ reports: reportIndex() }));

  app.get<{ Params: { name: string } }>('/api/reports/:name', async (request, reply) => {
    try {
      const markdown = await buildReport(request.params.name);
      if (markdown === null) return reply.code(404).send({ error: 'unknown report' });
      return { slug: request.params.name, markdown };
    } catch (err) {
      app.log.error({ event: 'report.build_failed', slug: request.params.name,
        message: (err as Error).message });
      return reply.code(500).send({
        error: `that report could not be built: ${(err as Error).message}`,
      });
    }
  });
}
