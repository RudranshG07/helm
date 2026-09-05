import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { close } from '@mandate/db';
import { registerAuthorizeRoutes } from './authorize.ts';
import { registerChargeQueueRoutes } from './charge-queue.ts';
import { registerControlRoutes } from './control.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerActionRoutes } from './actions.ts';
import { registerLoginRoutes } from './login.ts';
import { registerOnboardRoutes } from './onboard.ts';
import { registerReauthRoutes } from './reauth.ts';
import { registerWebhookRoutes } from './webhook.ts';

const PUBLIC = new Set([
  'GET /health',
  'GET /api/public',
  'GET /api/docs',
  'GET /api/proof',
  'GET /api/control',
  'GET /api/reports',
  'GET /api/reports/:name',
  'POST /api/auth/login',
  'POST /api/onboard/connect',
  'POST /api/onboard/upload',
  'POST /webhooks/razorpay',
  'GET /r/:token',
  'POST /r/:token/promise',
  'GET /r/:token/stop',
]);

let app: FastifyInstance;
const registered: { method: string; url: string }[] = [];

beforeAll(async () => {
  app = Fastify();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      registered.push({ method, url: route.url });
    }
  });
  app.get('/health', async () => ({ ok: true }));
  registerDashboardRoutes(app);
  registerControlRoutes(app);
  registerActionRoutes(app);
  registerLoginRoutes(app);
  registerOnboardRoutes(app);
  registerChargeQueueRoutes(app);
  registerAuthorizeRoutes(app);
  registerReauthRoutes(app);
  registerWebhookRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await close();
});

describe('every route states who may reach it', () => {
  it('registers the routes the application serves', () => {
    expect(registered.length).toBeGreaterThan(15);
  });

  it('refuses every route that is not deliberately public', async () => {
    const leaked: string[] = [];

    for (const { method, url } of registered) {
      const key = `${method} ${url}`;
      if (PUBLIC.has(key)) continue;

      const path = url.replace(/:[a-zA-Z_]+/g, 'probe');
      const response = await app.inject({
        method: method as 'GET',
        url: path,
        ...(method === 'POST' ? { payload: {} } : {}),
      });

      if (response.statusCode !== 401) {
        leaked.push(`${key} answered ${response.statusCode} to a stranger`);
      }
    }

    expect(leaked, 'these routes must either require a session or be listed as public').toEqual([]);
  });

  it('lists nothing as public that no longer exists', () => {
    const keys = new Set(registered.map((r) => `${r.method} ${r.url}`));
    const stale = [...PUBLIC].filter((p) => !keys.has(p));
    expect(stale, 'the public list has drifted from the routes').toEqual([]);
  });
});
