import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveMasterKey, encryptSecret, fingerprint } from '@mandate/core';
import { close, query } from '@mandate/db';
import { hashPassword, verifyPassword } from './auth.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerLoginRoutes } from './login.ts';

const M = 'merchant_auth_test';
const IMPORTED = 'merchant_auth_imported';
const KEY_ID = 'rzp_test_AUTHTESTKEY1';
const KEY_SECRET = 'the-real-key-secret';
const PASSWORD = 'a-long-enough-password';

let app: FastifyInstance;

function cookieFrom(headers: Record<string, unknown>): string | null {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? (value.split(';')[0] ?? null) : null;
}

beforeAll(async () => {
  process.env['SECRET_MASTER_KEY'] ??= 'a-test-master-key-long-enough-for-the-suite';
  const key = deriveMasterKey(process.env['SECRET_MASTER_KEY']!);

  for (const id of [M, IMPORTED]) {
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [id]);
    await query(`DELETE FROM merchant WHERE id = $1`, [id]);
  }
  await query(
    `INSERT INTO merchant (id, name, mode, rzp_key_id, rzp_key_secret_enc, key_fingerprint)
     VALUES ($1, 'Iron Works', 'test', $2, $3, $4)`,
    [M, KEY_ID, encryptSecret(KEY_SECRET, key), fingerprint(KEY_ID)],
  );
  await query(
    `INSERT INTO merchant (id, name, mode, email, password_hash, password_set_at)
     VALUES ($1, 'Tiffin Imported', 'test', 'owner@tiffin.test', $2, now())`,
    [IMPORTED, await hashPassword(PASSWORD)],
  );

  app = Fastify();
  registerLoginRoutes(app);
  registerDashboardRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await close();
});

const login = (payload: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload });

describe('a merchant signs in with the credential they already hold', () => {
  it('opens the dashboard with the Razorpay key and secret', async () => {
    const res = await login({ key_id: KEY_ID, key_secret: KEY_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchant_id: M, name: 'Iron Works' });
  });

  it('refuses the right key with the wrong secret', async () => {
    const res = await login({ key_id: KEY_ID, key_secret: `${KEY_SECRET}x` });
    expect(res.statusCode).toBe(401);
    expect(cookieFrom(res.headers)).toBeNull();
  });

  it('refuses a key that belongs to nobody, with the same words', async () => {
    const unknown = await login({ key_id: 'rzp_test_NOSUCHKEY99', key_secret: KEY_SECRET });
    const wrong = await login({ key_id: KEY_ID, key_secret: 'wrong' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe(wrong.json().error);
  });

  it('refuses something that is not a Razorpay key at all', async () => {
    const res = await login({ key_id: 'sk_live_stripe', key_secret: KEY_SECRET });
    expect(res.statusCode).toBe(401);
  });

  it('sets a cookie the page scripts cannot read', async () => {
    const res = await login({ key_id: KEY_ID, key_secret: KEY_SECRET });
    const header = res.headers['set-cookie'];
    const cookie = Array.isArray(header) ? header[0]! : (header as string);
    expect(cookie).toContain('helm_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('opens the dashboard with nothing but that cookie', async () => {
    const cookie = cookieFrom((await login({ key_id: KEY_ID, key_secret: KEY_SECRET })).headers)!;
    expect((await app.inject({ method: 'GET', url: '/api/overview' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).statusCode).toBe(200);
  });

  it('stops working the moment you sign out', async () => {
    const cookie = cookieFrom((await login({ key_id: KEY_ID, key_secret: KEY_SECRET })).headers)!;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('a merchant signs in with their email once the account exists', () => {
  it('accepts the email and password', async () => {
    const res = await login({ email: 'owner@tiffin.test', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchant_id: IMPORTED });
  });

  it('does not care about the case of the email', async () => {
    const res = await login({ email: 'OWNER@TIFFIN.TEST', password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('refuses the wrong password', async () => {
    const res = await login({ email: 'owner@tiffin.test', password: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an account that has no password set', async () => {
    const res = await login({ email: 'nobody@nowhere.test', password: PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  it('asks for something rather than signing in an empty form', async () => {
    const res = await login({});
    expect(res.statusCode).toBe(400);
  });

  it('signs in with email after the keys were only ever typed once', async () => {
    const byKeys = await login({ key_id: KEY_ID, key_secret: KEY_SECRET });
    expect(byKeys.statusCode).toBe(200);

    await query(
      `UPDATE merchant SET email = $2, password_hash = $3, password_set_at = now() WHERE id = $1`,
      [M, 'owner@ironworks.test', await hashPassword(PASSWORD)],
    );

    const byEmail = await login({ email: 'owner@ironworks.test', password: PASSWORD });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json()).toMatchObject({ merchant_id: M });
  });
});

describe('a password, where one exists, is stored so a leak does not reveal it', () => {
  it('never keeps the password itself', async () => {
    const { rows } = await query<{ password_hash: string }>(
      `SELECT password_hash FROM merchant WHERE id = $1`, [IMPORTED],
    );
    expect(rows[0]!.password_hash).not.toContain(PASSWORD);
    expect(rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('gives two merchants different hashes for the same password', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });
});
