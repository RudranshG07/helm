import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveMasterKey, encryptSecret, fingerprint } from '@mandate/core';
import { close, query } from '@mandate/db';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerLoginRoutes } from './login.ts';

const M = 'merchant_sessions_test';
const KEY_ID = 'rzp_test_SESSIONKEY01';
const KEY_SECRET = 'the-real-key-secret';

let app: FastifyInstance;

const cookieOf = (headers: Record<string, unknown>) => {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? (value.split(';')[0] ?? null) : null;
};

const login = () =>
  app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { key_id: KEY_ID, key_secret: KEY_SECRET },
  });

const overview = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });

beforeAll(async () => {
  process.env['SECRET_MASTER_KEY'] ??= 'a-test-master-key-long-enough-for-the-suite';
  const key = deriveMasterKey(process.env['SECRET_MASTER_KEY']!);

  await query(`DELETE FROM merchant_session WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM subscription WHERE merchant_id = $1`, [M]);
  await query(`DELETE FROM merchant WHERE id = $1`, [M]);
  await query(
    `INSERT INTO merchant (id, name, mode, rzp_key_id, rzp_key_secret_enc, key_fingerprint)
     VALUES ($1, 'Two Devices', 'test', $2, $3, $4)`,
    [M, KEY_ID, encryptSecret(KEY_SECRET, key), fingerprint(KEY_ID)],
  );

  app = Fastify();
  registerLoginRoutes(app);
  registerDashboardRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await query(`DELETE FROM merchant_session WHERE merchant_id = $1`, [M]);
  await app.close();
  await close();
});

describe('signing in on one device does not sign you out on another', () => {
  it('keeps both sessions alive', async () => {
    const laptop = cookieOf((await login()).headers)!;
    const phone = cookieOf((await login()).headers)!;

    expect(laptop).not.toBe(phone);
    expect((await overview(laptop)).statusCode, 'the first device must survive the second sign-in').toBe(200);
    expect((await overview(phone)).statusCode).toBe(200);
  });

  it('ends only the session that signed out', async () => {
    const laptop = cookieOf((await login()).headers)!;
    const phone = cookieOf((await login()).headers)!;

    const out = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie: phone }, payload: {},
    });
    expect(out.statusCode).toBe(200);
    expect(out.json().everywhere).toBe(false);

    expect((await overview(phone)).statusCode, 'the signed-out device must be dead').toBe(401);
    expect((await overview(laptop)).statusCode, 'the other device must still work').toBe(200);
  });

  it('can end every session when asked to', async () => {
    const laptop = cookieOf((await login()).headers)!;
    const phone = cookieOf((await login()).headers)!;

    const out = await app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { cookie: phone }, payload: { everywhere: true },
    });
    expect(out.json().everywhere).toBe(true);

    expect((await overview(phone)).statusCode).toBe(401);
    expect((await overview(laptop)).statusCode).toBe(401);
  });

  it('records each session separately', async () => {
    await query(`DELETE FROM merchant_session WHERE merchant_id = $1`, [M]);
    await login();
    await login();

    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM merchant_session WHERE merchant_id = $1`, [M],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('notes when a session was last used', async () => {
    const cookie = cookieOf((await login()).headers)!;
    await overview(cookie);

    const { rows } = await query<{ seen: Date | null }>(
      `SELECT last_seen_at AS seen FROM merchant_session
        WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`, [M],
    );
    expect(rows[0]!.seen).not.toBeNull();
  });
});
