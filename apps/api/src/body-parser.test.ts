import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

function build() {
  const app = Fastify();
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
  app.post('/echo', async (request) => ({
    body: request.body,
    raw: (request as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? null,
  }));
  return app;
}

describe('the webhook raw-body parser must not break every other POST', () => {
  it('parses the JSON body so handlers can read it', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ engaged: false, token: 'x' }),
    });
    expect(res.json().body).toEqual({ engaged: false, token: 'x' });
    await app.close();
  });

  it('preserves the exact raw bytes, which signature verification depends on', async () => {
    const app = build();
    const payload = '{"event":"subscription.pending",  "spaced": true}';
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.json().raw).toBe(payload);
    await app.close();
  });

  it('a false value survives, rather than becoming undefined', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ engaged: false }),
    });
    expect(res.json().body.engaged).toBe(false);
    await app.close();
  });

  it('an empty body becomes an object, not undefined', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.json().body).toEqual({});
    await app.close();
  });

  it('malformed JSON is rejected rather than silently becoming undefined', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});
