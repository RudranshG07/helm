import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';

const REPORTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs');

const REPORTS: Record<string, string> = {
  contention: 'contention.md',
  results: 'results.md',
  backtest: 'backtest.md',
  'off-policy': 'off-policy.md',
  adversarial: 'adversarial.md',
  taxonomy: 'taxonomy.md',
};

export function registerControlRoutes(app: FastifyInstance): void {
  app.get('/api/merchants', async () => {
    const { rows } = await query(
      `SELECT m.id, m.name, m.mode, m.integration, m.write_enabled, m.cross_merchant_signals,
              m.consent_signed_at,
              (SELECT count(*)::int FROM subscription s WHERE s.merchant_id = m.id) AS subscriptions
         FROM merchant m ORDER BY m.name`,
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

  app.get('/api/reports', async () => {
    let present: string[] = [];
    try {
      present = readdirSync(REPORTS_DIR);
    } catch {
      present = [];
    }
    return {
      reports: Object.entries(REPORTS)
        .filter(([, file]) => present.includes(file))
        .map(([slug, file]) => ({ slug, file })),
    };
  });

  app.get<{ Params: { name: string } }>('/api/reports/:name', async (request, reply) => {
    const file = REPORTS[request.params.name];
    if (!file) return reply.code(404).send({ error: 'unknown report' });
    try {
      return { slug: request.params.name, markdown: readFileSync(join(REPORTS_DIR, file), 'utf8') };
    } catch {
      return reply.code(404).send({ error: 'report has not been generated yet' });
    }
  });
}
