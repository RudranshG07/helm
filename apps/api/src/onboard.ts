import { requireOwnMerchant, signIn } from './session.ts';
import { checkPassword, hashPassword } from './auth.ts';
import { buildRecoveryReport } from '@mandate/worker/report/recovery';
import type { FastifyInstance } from 'fastify';
import {
  decryptSecret, deriveMasterKey, encryptSecret, fingerprint, inspectKeyId,
  importAttempts, parseCsv,
} from '@mandate/core';
import { query, withTransaction } from '@mandate/db';

function masterKey(): Buffer {
  const secret = process.env['SECRET_MASTER_KEY'];
  if (!secret) {
    throw new Error('SECRET_MASTER_KEY is not configured. Merchant keys cannot be stored safely.');
  }
  return deriveMasterKey(secret);
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return base.length > 0 ? base : `merchant_${Date.now()}`;
}

async function verifyKeys(keyId: string, keySecret: string): Promise<{ ok: true } | { ok: false; problem: string }> {
  const auth = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  let response: Response;
  try {
    response = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch {
    return { ok: false, problem: 'Could not reach Razorpay. Check the connection and try again.' };
  }

  if (response.status === 401) {
    return { ok: false, problem: 'Razorpay rejected these credentials. Check the key ID and secret.' };
  }
  if (!response.ok) {
    return { ok: false, problem: `Razorpay responded ${response.status}. The key may lack read access.` };
  }
  return { ok: true };
}

const ACKNOWLEDGEMENT = 'I authorise Helm to charge my customers';

export function registerOnboardRoutes(app: FastifyInstance): void {
  app.post<{ Body: { name?: string; key_id?: string; key_secret?: string } }>(
    '/api/onboard/connect',
    async (request, reply) => {
      const name = (request.body?.name ?? '').trim();
      const keyId = (request.body?.key_id ?? '').trim();
      const keySecret = (request.body?.key_secret ?? '').trim();

      if (name.length === 0) return reply.code(400).send({ error: 'Give the business a name.' });

      const shape = inspectKeyId(keyId);
      if (!shape.valid) return reply.code(400).send({ error: shape.problem });
      if (keySecret.length < 8) return reply.code(400).send({ error: 'The key secret looks incomplete.' });

      if (shape.mode === 'live') {
        return reply.code(400).send({
          error:
            'This accepts test-mode keys only for now. Live keys move real money and need written ' +
            'consent recorded first.',
        });
      }

      let key: Buffer;
      try {
        key = masterKey();
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }

      const check = await verifyKeys(keyId, keySecret);
      if (!check.ok) return reply.code(400).send({ error: check.problem });

      const print = fingerprint(keyId);
      const { rows: existing } = await query<{ id: string }>(
        `SELECT id FROM merchant WHERE key_fingerprint = $1`, [print],
      );
      const resumed = existing.length > 0;
      const id = existing[0]?.id ?? slug(name);


      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO merchant (
             id, name, mode, rzp_key_id, rzp_key_secret_enc, key_fingerprint,
             integration, onboarding_state, connected_at, write_enabled
           ) VALUES ($1,$2,$3,$4,$5,$6,'recurring_tokens','backfilling',clock_timestamp(),FALSE)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             rzp_key_id = EXCLUDED.rzp_key_id,
             rzp_key_secret_enc = EXCLUDED.rzp_key_secret_enc,
             key_fingerprint = EXCLUDED.key_fingerprint,
             onboarding_state = 'backfilling',
             onboarding_error = NULL,
             connected_at = clock_timestamp()`,
          [id, name, shape.mode, keyId, encryptSecret(keySecret, key), fingerprint(keyId)],
        );

        await client.query(
          `INSERT INTO onboarding_job (merchant_id, kind) VALUES ($1, 'backfill')`,
          [id],
        );
      });

      await signIn(request, reply, id);
      app.log.info({ event: 'onboard.connected', merchant_id: id, mode: shape.mode });
      return { merchant_id: id, state: 'backfilling', mode: shape.mode, resumed };
    },
  );

  app.post<{ Body: { name?: string; csv?: string; password?: string } }>(
    '/api/onboard/upload',
    async (request, reply) => {
      const name = (request.body?.name ?? '').trim();
      const csv = request.body?.csv ?? '';
      const password = request.body?.password ?? '';

      if (name.length === 0) return reply.code(400).send({ error: 'Give the business a name.' });
      if (csv.length === 0) return reply.code(400).send({ error: 'The file is empty.' });

      const passwordShape = checkPassword(password);
      if (!passwordShape.ok) return reply.code(400).send({ error: passwordShape.problem });
      if (csv.length > 12_000_000) {
        return reply.code(413).send({ error: 'That file is larger than 12 MB. Split it and try again.' });
      }

      let preview;
      try {
        preview = importAttempts(parseCsv(csv));
      } catch (err) {
        return reply.code(400).send({ error: `Could not read that file. ${(err as Error).message}` });
      }

      if (preview.attempts.length === 0) {
        return reply.code(400).send({
          error: preview.problems[0]?.reason ?? 'No usable rows found in that file.',
        });
      }

      const id = slug(name);
      const passwordHash = await hashPassword(password);

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO merchant (id, name, mode, onboarding_state, connected_at, write_enabled,
                                 password_hash, password_set_at)
           VALUES ($1,$2,'test','backfilling',clock_timestamp(),FALSE,$3,now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, onboarding_state = 'backfilling', onboarding_error = NULL,
             password_hash = EXCLUDED.password_hash, password_set_at = now()`,
          [id, name, passwordHash],
        );
        await client.query(
          `INSERT INTO onboarding_job (merchant_id, kind, progress)
           VALUES ($1, 'csv_import', $2::jsonb)`,
          [id, JSON.stringify({ csv, rows: preview.attempts.length })],
        );
      });

      await signIn(request, reply, id);
      app.log.info({ event: 'onboard.uploaded', merchant_id: id, rows: preview.attempts.length });
      return {
        merchant_id: id,
        state: 'backfilling',
        rows_readable: preview.attempts.length,
        rows_seen: preview.rows_seen,
        unrecognised_columns: preview.unrecognised_columns,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/onboard/:id/status', async (request, reply) => {
    if (!(await requireOwnMerchant(request, reply, request.params.id))) return reply;
    const { rows } = await query<{
      onboarding_state: string; onboarding_error: string | null;
      subscriptions: number; attempts: number; failures: number;
    }>(
      `SELECT m.onboarding_state, m.onboarding_error,
              (SELECT count(*)::int FROM subscription s WHERE s.merchant_id = m.id) AS subscriptions,
              (SELECT count(*)::int FROM payment_attempt pa
                 JOIN subscription s2 ON s2.id = pa.subscription_id
                WHERE s2.merchant_id = m.id) AS attempts,
              (SELECT count(*)::int FROM payment_attempt pa
                 JOIN subscription s3 ON s3.id = pa.subscription_id
                WHERE s3.merchant_id = m.id AND pa.status = 'failed') AS failures
         FROM merchant m WHERE m.id = $1`,
      [request.params.id],
    );

    if (!rows[0]) return reply.code(404).send({ error: 'unknown merchant' });

    const { rows: job } = await query<{ state: string; progress: unknown; error: string | null }>(
      `SELECT state, progress, error FROM onboarding_job
        WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [request.params.id],
    );

    return { ...rows[0], job: job[0] ?? null };
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/onboard/:id/report',
    async (request, reply) => {
      if (!(await requireOwnMerchant(request, reply, request.params.id))) return reply;
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM merchant WHERE id = $1`, [request.params.id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'unknown merchant' });

      const days = Math.min(Math.max(Number(request.query.days ?? 180), 1), 730);
      try {
        return await buildRecoveryReport(request.params.id, days);
      } catch (err) {
        app.log.error({ event: 'report.failed', message: (err as Error).message });
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/onboard/:id/consent', async (request, reply) => {
    if (!(await requireOwnMerchant(request, reply, request.params.id))) return reply;
    const { rows } = await query<{
      write_enabled: boolean; consent_signed_at: Date | null; mode: string;
      would_charge: number; would_charge_paise: string; refusals: number;
    }>(
      `SELECT m.write_enabled, m.consent_signed_at, m.mode,
              (SELECT count(*)::int FROM execution_intent i
                 JOIN subscription s2 ON s2.id = i.subscription_id
                WHERE s2.merchant_id = m.id AND i.dry_run) AS would_charge,
              (SELECT COALESCE(sum(i.amount_paise),0)::text FROM execution_intent i
                 JOIN subscription s3 ON s3.id = i.subscription_id
                WHERE s3.merchant_id = m.id AND i.dry_run) AS would_charge_paise,
              (SELECT count(*)::int FROM decision d
                 JOIN subscription s4 ON s4.id = d.subscription_id
                WHERE s4.merchant_id = m.id AND d.verdict = 'DENY') AS refusals
         FROM merchant m WHERE m.id = $1`,
      [request.params.id],
    );

    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'unknown merchant' });

    return {
      merchant_id: request.params.id,
      write_enabled: row.write_enabled,
      consent_signed_at: row.consent_signed_at,
      mode: row.mode,
      dry_run_charges: row.would_charge,
      dry_run_amount_paise: Number(row.would_charge_paise),
      refusals: row.refusals,
    };
  });

  app.post<{ Params: { id: string }; Body: { granted?: boolean; acknowledged?: string } }>(
    '/api/onboard/:id/consent',
    async (request, reply) => {
      if (!(await requireOwnMerchant(request, reply, request.params.id))) return reply;
      const granted = request.body?.granted === true;

      if (granted && request.body?.acknowledged !== ACKNOWLEDGEMENT) {
        return reply.code(400).send({
          error: `To grant write access, acknowledge exactly: "${ACKNOWLEDGEMENT}"`,
        });
      }

      const { rows } = await query<{ id: string; mode: string }>(
        `SELECT id, mode FROM merchant WHERE id = $1`, [request.params.id],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'unknown merchant' });

      await query(
        `UPDATE merchant
            SET write_enabled = $2,
                consent_signed_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END
          WHERE id = $1`,
        [request.params.id, granted],
      );

      app.log.warn({
        event: granted ? 'merchant.write_granted' : 'merchant.write_revoked',
        merchant_id: request.params.id,
        mode: rows[0].mode,
      });

      return { merchant_id: request.params.id, write_enabled: granted };
    },
  );

  app.get<{ Params: { id: string } }>('/api/onboard/:id/keycheck', async (request, reply) => {
    if (!(await requireOwnMerchant(request, reply, request.params.id))) return reply;
    const { rows } = await query<{ rzp_key_id: string | null; rzp_key_secret_enc: Buffer | null }>(
      `SELECT rzp_key_id, rzp_key_secret_enc FROM merchant WHERE id = $1`,
      [request.params.id],
    );
    const row = rows[0];
    if (!row?.rzp_key_id || !row.rzp_key_secret_enc) {
      return reply.code(404).send({ error: 'no credentials stored for this merchant' });
    }
    try {
      decryptSecret(row.rzp_key_secret_enc, masterKey());
      return { ok: true, key_id: row.rzp_key_id };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });
}
