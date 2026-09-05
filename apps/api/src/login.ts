import type { FastifyInstance } from 'fastify';
import { query } from '@mandate/db';
import { checkEmail, checkPassword, hashPassword, normaliseEmail, verifyPassword } from './auth.ts';
import { clearSessionCookie, requireMerchant, signIn } from './session.ts';

const MAX_ATTEMPTS = 6;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; first: number }>();

function tooManyAttempts(key: string): boolean {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string): void {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

let decoy: string | null = null;
async function decoyHash(): Promise<string> {
  decoy ??= await hashPassword(`no-such-account-${Math.random()}`);
  return decoy;
}

export function registerLoginRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/auth/login',
    async (request, reply) => {
      const email = normaliseEmail(request.body?.email ?? '');
      const password = request.body?.password ?? '';

      if (email.length === 0 || password.length === 0) {
        return reply.code(400).send({ error: 'Enter your email and password.' });
      }
      if (tooManyAttempts(email)) {
        return reply.code(429).send({
          error: 'Too many attempts. Wait fifteen minutes, or reconnect your Razorpay key to set a new password.',
        });
      }

      const { rows } = await query<{ id: string; name: string; password_hash: string | null }>(
        `SELECT id, name, password_hash FROM merchant WHERE lower(email) = $1`,
        [email],
      );
      const row = rows[0];
      const correct = await verifyPassword(password, row?.password_hash ?? (await decoyHash()));

      if (!row || !correct) {
        recordFailure(email);
        app.log.warn({ event: 'auth.failed', email_known: Boolean(row) });
        return reply.code(401).send({ error: 'That email and password do not match an account.' });
      }

      attempts.delete(email);
      await signIn(request, reply, row.id);
      app.log.info({ event: 'auth.signed_in', merchant_id: row.id });
      return { merchant_id: row.id, name: row.name };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;

    await query(
      `UPDATE merchant SET session_token_hash = NULL, session_issued_at = NULL WHERE id = $1`,
      [merchant],
    );
    clearSessionCookie(request, reply);
    return { signed_out: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const merchant = await requireMerchant(request, reply);
    if (merchant === null) return reply;

    const { rows } = await query<{ id: string; name: string; email: string | null }>(
      `SELECT id, name, email FROM merchant WHERE id = $1`, [merchant],
    );
    return rows[0] ?? { id: merchant, name: merchant, email: null };
  });

  app.post<{ Body: { password?: string } }>(
    '/api/auth/password',
    async (request, reply) => {
      const merchant = await requireMerchant(request, reply);
      if (merchant === null) return reply;

      const password = request.body?.password ?? '';
      const shape = checkPassword(password);
      if (!shape.ok) return reply.code(400).send({ error: shape.problem });

      await query(
        `UPDATE merchant SET password_hash = $2, password_set_at = now() WHERE id = $1`,
        [merchant, await hashPassword(password)],
      );
      return { updated: true };
    },
  );
}

export { checkEmail, checkPassword };
