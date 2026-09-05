import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close, query } from '@mandate/db';
import { hashPassword, verifyPassword } from './auth.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerLoginRoutes } from './login.ts';

const M = 'merchant_auth_test';
const OTHER = 'merchant_auth_other';
const EMAIL = 'owner@ironworks.test';
const PASSWORD = 'a-long-enough-password';

let app: FastifyInstance;

function cookieFrom(headers: Record<string, unknown>): string | null {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return value.split(';')[0] ?? null;
}

beforeAll(async () => {
  for (const id of [M, OTHER]) {
    await query(`DELETE FROM subscription WHERE merchant_id = $1`, [id]);
    await query(`DELETE FROM merchant WHERE id = $1`, [id]);
  }
  await query(
    `INSERT INTO merchant (id, name, mode, email, password_hash, password_set_at)
     VALUES ($1, 'Iron Works', 'test', $2, $3, now())`,
    [M, EMAIL, await hashPassword(PASSWORD)],
  );
  await query(
    `INSERT INTO merchant (id, name, mode) VALUES ($1, 'Other', 'test')`,
    [OTHER],
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

describe('a password is stored so a database leak does not reveal it', () => {
  it('never keeps the password itself', async () => {
    const { rows } = await query<{ password_hash: string }>(
      `SELECT password_hash FROM merchant WHERE id = $1`, [M],
    );
    expect(rows[0]!.password_hash).not.toContain(PASSWORD);
    expect(rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('accepts the right password and refuses a near miss', async () => {
    const stored = (await query<{ password_hash: string }>(
      `SELECT password_hash FROM merchant WHERE id = $1`, [M],
    )).rows[0]!.password_hash;

    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, stored)).toBe(false);
    expect(await verifyPassword(PASSWORD.slice(0, -1), stored)).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
  });

  it('gives two merchants different hashes for the same password', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });
});

describe('signing in', () => {
  it('refuses a wrong password without saying whether the email exists', async () => {
    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: EMAIL, password: 'not-the-password' },
    });
    const noSuchEmail = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@nowhere.test', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error).toBe(noSuchEmail.json().error);
    expect(cookieFrom(wrongPassword.headers)).toBeNull();
  });

  it('sets a cookie the browser will not hand to scripts', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);

    const header = res.headers['set-cookie'];
    const cookie = Array.isArray(header) ? header[0]! : (header as string);
    expect(cookie).toContain('helm_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('is case insensitive about the email', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: EMAIL.toUpperCase(), password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it('opens the dashboard with nothing but that cookie', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = cookieFrom(login.headers)!;

    const before = await app.inject({ method: 'GET', url: '/api/overview' });
    const after = await app.inject({
      method: 'GET', url: '/api/overview', headers: { cookie },
    });

    expect(before.statusCode).toBe(401);
    expect(after.statusCode).toBe(200);
  });

  it('says who is signed in', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD },
    });
    const me = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(login.headers)! },
    });
    expect(me.json()).toMatchObject({ id: M, name: 'Iron Works', email: EMAIL });
  });

  it('stops working the moment you sign out', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD },
    });
    const cookie = cookieFrom(login.headers)!;

    expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(after.statusCode, 'the old cookie must be dead, not merely cleared in the browser').toBe(401);
  });
});
