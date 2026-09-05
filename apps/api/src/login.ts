import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decryptSecret, deriveMasterKey, fingerprint, inspectKeyId } from '@mandate/core';
import { query } from '@mandate/db';
import { checkPassword, hashPassword, normaliseEmail, verifyPassword } from './auth.ts';
import { clearSessionCookie, requireMerchant, signIn } from './session.ts';

const MAX_ATTEMPTS = 6;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; first: number }>();

function masterKey(): Buffer {
  const secret = process.env['SECRET_MASTER_KEY'];
  if (!secret) throw new Error('SECRET_MASTER_KEY is not configured.');
  return deriveMasterKey(secret);
}

function tooMany(key: string): boolean {
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

function sameSecret(supplied: string, stored: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const WRONG = 'Those credentials do not open a dashboard here.';

async function byKey(keyId: string, keySecret: string): Promise<{ id: string; name: string } | null> {
  const shape = inspectKeyId(keyId);
  if (!shape.valid) return null;

  const { rows } = await query<{ id: string; name: string; rzp_key_secret_enc: Buffer | null }>(
    `SELECT id, name, rzp_key_secret_enc FROM merchant WHERE key_fingerprint = $1`,
    [fingerprint(keyId)],
  );
  const row = rows[0];
  if (!row?.rzp_key_secret_enc) return null;

  let stored: string;
  try {
    stored = decryptSecret(row.rzp_key_secret_enc, masterKey());
  } catch {
    return null;
  }
  return sameSecret(keySecret, stored) ? { id: row.id, name: row.name } : null;
}

async function byEmail(email: string, password: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query<{ id: string; name: string; password_hash: string | null }>(
    `SELECT id, name, password_hash FROM merchant WHERE lower(email) = $1`,
    [normaliseEmail(email)],
  );
  const row = rows[0];
  if (!row) return null;
  return (await verifyPassword(password, row.password_hash)) ? { id: row.id, name: row.name } : null;
}

export function registerLoginRoutes(app: FastifyInstance): void {
  app.post<{
    Body: { key_id?: string; key_secret?: string; email?: string; password?: string };
  }>('/api/auth/login', async (request, reply) => {
    const keyId = (request.body?.key_id ?? '').trim();
    const keySecret = (request.body?.key_secret ?? '').trim();
    const email = normaliseEmail(request.body?.email ?? '');
    const password = request.body?.password ?? '';

    const usingKeys = keyId.length > 0 || keySecret.length > 0;
    const throttleKey = usingKeys ? keyId.toLowerCase() : email;

    if (usingKeys ? keySecret.length === 0 || keyId.length === 0 : email.length === 0 || password.length === 0) {
      return reply.code(400).send({
        error: 'Sign in with your email and password, or with your Razorpay key id and secret.',
      });
    }
    if (tooMany(throttleKey)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait fifteen minutes and try again.' });
    }

    const merchant = usingKeys ? await byKey(keyId, keySecret) : await byEmail(email, password);

    if (!merchant) {
      recordFailure(throttleKey);
      app.log.warn({ event: 'auth.failed', method: usingKeys ? 'key' : 'password' });
      return reply.code(401).send({ error: WRONG });
    }

    attempts.delete(throttleKey);
    await signIn(request, reply, merchant.id);
    app.log.info({ event: 'auth.signed_in', merchant_id: merchant.id, method: usingKeys ? 'key' : 'password' });
    return { merchant_id: merchant.id, name: merchant.name };
  });

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

    const { rows } = await query<{ id: string; name: string; email: string | null; has_keys: boolean }>(
      `SELECT id, name, email, (rzp_key_id IS NOT NULL) AS has_keys
         FROM merchant WHERE id = $1`,
      [merchant],
    );
    return rows[0] ?? { id: merchant, name: merchant, email: null, has_keys: false };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/password', async (request, reply) => {
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
  });
}
