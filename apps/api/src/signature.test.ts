import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './signature.ts';

const SECRET = 'whsec_test_abc123';
const body = Buffer.from(JSON.stringify({ event: 'subscription.pending' }));
const valid = createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts a signature computed over the exact raw bytes', () => {
    expect(verifyWebhookSignature(body, valid, SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const wrong = createHmac('sha256', 'whsec_live_other').update(body).digest('hex');
    expect(verifyWebhookSignature(body, wrong, SECRET)).toBe(false);
  });

  it('rejects when a single byte of the body changed', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'subscription.charged' }));
    expect(verifyWebhookSignature(tampered, valid, SECRET)).toBe(false);
  });

  it('rejects a re-serialised body, which is how this breaks in practice', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + ' ');
    expect(verifyWebhookSignature(reserialised, valid, SECRET)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects an empty secret', () => {
    expect(verifyWebhookSignature(body, valid, '')).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    expect(verifyWebhookSignature(body, valid.slice(0, 32), SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong encoding without throwing', () => {
    const b64 = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(verifyWebhookSignature(body, b64, SECRET)).toBe(false);
  });
});
