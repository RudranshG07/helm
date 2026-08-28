import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.ts';
import { close, query } from '@mandate/db';
import { registerChargeQueueRoutes } from './charge-queue.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerWebhookRoutes } from './webhook.ts';

const REDACTED_KEYS = [
  'key_secret', 'rzp_key_secret', 'webhook_secret', 'authorization',
  'x-razorpay-signature', 'token', 'password', 'email', 'contact',
];

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: {
      paths: REDACTED_KEYS.flatMap((k) => [k, `*.${k}`, `req.headers.${k}`]),
      censor: '[redacted]',
    },
  },
  bodyLimit: 1_048_576,
});

app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    (req as { rawBody?: Buffer }).rawBody = body as Buffer;
    done(null, undefined);
  },
);

app.get('/health', async () => {
  await query('SELECT 1');
  return { ok: true, mode: config.mode, dry_run: config.dryRun };
});

registerWebhookRoutes(app);
registerDashboardRoutes(app);
registerChargeQueueRoutes(app);

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.get('/dashboard', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/webhooks')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (request.url.startsWith('/dashboard')) return reply.sendFile('dashboard.html');
    return reply.sendFile('index.html');
  });
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ event: 'shutdown', signal });
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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
