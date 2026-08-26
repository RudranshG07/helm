import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '@mandate/db';
import { config, webhookSecret } from './config.ts';
import { verifyWebhookSignature } from './signature.ts';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/razorpay', async (request, reply) => {
    const raw = (request as RawBodyRequest).rawBody;
    if (!raw) {
      return reply.code(400).send({ error: 'missing body' });
    }

    const signature = request.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      app.log.warn({ event: 'webhook.signature_missing' });
      return reply.code(400).send({ error: 'missing signature' });
    }

    if (!verifyWebhookSignature(raw, signature, webhookSecret(config.mode))) {
      app.log.warn({ event: 'webhook.signature_invalid', mode: config.mode });
      return reply.code(400).send({ error: 'invalid signature' });
    }

    const eventId = request.headers['x-razorpay-event-id'];
    if (typeof eventId !== 'string') {
      return reply.code(400).send({ error: 'missing event id' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      app.log.error({ event: 'webhook.unparseable', eventId });
      return reply.code(400).send({ error: 'unparseable payload' });
    }

    const eventType = typeof payload['event'] === 'string' ? payload['event'] : 'unknown';

    const result = await query(
      `INSERT INTO raw_event (rzp_event_id, event_type, payload, signature_ok)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (rzp_event_id, event_type) DO NOTHING
       RETURNING id`,
      [eventId, eventType, payload],
    );

    const duplicate = result.rowCount === 0;
    app.log.info({
      event: 'webhook.received',
      eventId,
      eventType,
      duplicate,
    });

    return reply.code(200).send({ received: true, duplicate });
  });
}
