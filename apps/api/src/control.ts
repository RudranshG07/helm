import { requireMerchant, resolveMerchant } from './session.ts';
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

  app.get('/api/control', async (request) => {
    const { rows } = await query<{
      kill_switch: boolean; kill_switch_reason: string | null; updated_at: Date;
    }>(`SELECT kill_switch, kill_switch_reason, updated_at FROM control_flags WHERE id = 1`);

    const merchant = await resolveMerchant(request);
    let halted = false;
    let halt_reason: string | null = null;

    if (merchant !== null) {
      const { rows: mine } = await query<{ halted_at: Date | null; halt_reason: string | null }>(
        `SELECT halted_at, halt_reason FROM merchant WHERE id = $1`,
        [merchant],
      );
      halted = mine[0]?.halted_at != null;
      halt_reason = mine[0]?.halt_reason ?? null;
    }

    return {
      ...rows[0],
      halted,
      halt_reason,
      dry_run: process.env['DRY_RUN'] !== 'false',
      mode: process.env['RAZORPAY_MODE'] ?? 'test',
    };
  });

  app.post<{ Body: { engaged?: boolean; reason?: string } }>(
    '/api/control/kill-switch',
    async (request, reply) => {
      const merchant = await requireMerchant(request, reply);
      if (merchant === null) return reply;

      const engaged = request.body?.engaged !== false;
      const reason = engaged
        ? (request.body?.reason?.trim() || 'halted from the dashboard')
        : null;

      await query(
        `UPDATE merchant
            SET halted_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
                halt_reason = $3
          WHERE id = $1`,
        [merchant, engaged, reason],
      );

      app.log.warn({
        event: engaged ? 'merchant.halted' : 'merchant.resumed',
        merchant_id: merchant,
      });
      return { halted: engaged, halt_reason: reason };
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
