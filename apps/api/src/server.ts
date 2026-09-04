import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.ts';
import { close, query } from '@mandate/db';
import { registerChargeQueueRoutes } from './charge-queue.ts';
import { registerControlRoutes } from './control.ts';
import { registerAuthorizeRoutes } from './authorize.ts';
import { registerOnboardRoutes } from './onboard.ts';
import { registerReauthRoutes } from './reauth.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerWebhookRoutes } from './webhook.ts';

const REDACTED_KEYS = [
  'key_secret', 'rzp_key_secret', 'webhook_secret', 'authorization',
  'x-razorpay-signature', 'x-helm-session', 'token', 'session',
  'password', 'email', 'contact',
];

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: {
      paths: REDACTED_KEYS.flatMap((k) => [k, `*.${k}`, `req.headers.${k}`]),
      censor: '[redacted]',
    },
  },
  bodyLimit: 16_777_216,
});

app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    const raw = body as Buffer;
    (req as { rawBody?: Buffer }).rawBody = raw;
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_req, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      done(null, Object.fromEntries(params.entries()));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

let embedded: { stop: () => void; running: () => boolean } | undefined;

app.get('/health', async () => {
  await query('SELECT 1');
  return { ok: true, mode: config.mode, dry_run: config.dryRun };
});

registerWebhookRoutes(app);
registerDashboardRoutes(app);
registerChargeQueueRoutes(app);
registerControlRoutes(app);
registerOnboardRoutes(app);
registerAuthorizeRoutes(app);
registerReauthRoutes(app);

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.get('/dashboard', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/onboard', async (_request, reply) => reply.sendFile('onboard.html'));
  app.get('/authorize', async (_request, reply) => reply.sendFile('authorize.html'));
  app.get('/proof', async (_request, reply) => reply.sendFile('proof.html'));
  app.get('/docs', async (_request, reply) => reply.sendFile('docs.html'));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/webhooks')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (request.url.startsWith('/dashboard')) return reply.sendFile('dashboard.html');
    if (request.url.startsWith('/onboard')) return reply.sendFile('onboard.html');
    if (request.url.startsWith('/authorize')) return reply.sendFile('authorize.html');
    if (request.url.startsWith('/proof')) return reply.sendFile('proof.html');
    if (request.url.startsWith('/docs')) return reply.sendFile('docs.html');
    return reply.sendFile('index.html');
  });
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ event: 'shutdown', signal });
  embedded?.stop();
  await app.close();
  await close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  if (!config.dryRun) {
    app.log.warn({ event: 'dry_run.disabled' });
  }

  if (process.env['RUN_WORKER'] === 'true') {
    const { startEmbeddedWorker } = await import('@mandate/worker/embedded');
    embedded = startEmbeddedWorker();
    app.log.info({ event: 'worker.embedded', reason: 'RUN_WORKER=true' });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
