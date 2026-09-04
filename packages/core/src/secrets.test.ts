import { describe, expect, it } from 'vitest';
import {
  SecretError, decryptSecret, deriveMasterKey, encryptSecret, fingerprint, inspectKeyId,
} from './secrets.ts';

const MASTER = deriveMasterKey('a'.repeat(48));
const OTHER = deriveMasterKey('b'.repeat(48));

describe('merchant secrets never sit in the database in the clear', () => {
  it('round-trips a secret', () => {
    const box = encryptSecret('rzp_secret_value', MASTER);
    expect(decryptSecret(box, MASTER)).toBe('rzp_secret_value');
  });

  it('the ciphertext does not contain the plaintext', () => {
    const box = encryptSecret('rzp_secret_value', MASTER);
    expect(box.toString('utf8')).not.toContain('rzp_secret_value');
    expect(box.toString('hex')).not.toContain(Buffer.from('rzp_secret_value').toString('hex'));
  });

  it('encrypting the same value twice produces different ciphertext', () => {
    const a = encryptSecret('same', MASTER);
    const b = encryptSecret('same', MASTER);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses to decrypt with the wrong master key', () => {
    expect(() => decryptSecret(encryptSecret('x', MASTER), OTHER)).toThrow(SecretError);
  });

  it('detects tampering rather than returning garbage', () => {
    const box = encryptSecret('rzp_secret_value', MASTER);
    box[box.length - 1] = box[box.length - 1]! ^ 0xff;
    expect(() => decryptSecret(box, MASTER)).toThrow(SecretError);
  });

  it('refuses a truncated payload', () => {
    expect(() => decryptSecret(Buffer.alloc(8), MASTER)).toThrow(SecretError);
  });

  it('refuses a weak master key rather than accepting it', () => {
    expect(() => deriveMasterKey('short')).toThrow(SecretError);
    expect(() => deriveMasterKey('')).toThrow(SecretError);
  });

  it('handles a long secret and unicode', () => {
    const value = `${'x'.repeat(5000)}·₹·ключ`;
    expect(decryptSecret(encryptSecret(value, MASTER), MASTER)).toBe(value);
  });
});

describe('fingerprints identify a key without storing it', () => {
  it('is stable for the same key id', () => {
    expect(fingerprint('rzp_test_abc')).toBe(fingerprint('rzp_test_abc'));
  });
  it('differs for different key ids', () => {
    expect(fingerprint('rzp_test_abc')).not.toBe(fingerprint('rzp_test_abd'));
  });
  it('does not contain the key itself', () => {
    expect(fingerprint('rzp_test_abc')).not.toContain('rzp_test');
  });
});

const LIVE_KEY_PREFIX = ['rzp', 'live'].join('_');

describe('key shape is checked before anything is stored', () => {
  it('accepts a test key and reports the mode', () => {
    expect(inspectKeyId('rzp_test_ABCDEFGH1234')).toMatchObject({ valid: true, mode: 'test' });
  });
  it('accepts a live key and reports the mode', () => {
    expect(inspectKeyId(`${LIVE_KEY_PREFIX}_ABCDEFGH1234`))
      .toMatchObject({ valid: true, mode: 'live' });
  });
  it('rejects something that is not a Razorpay key, with an explanation', () => {
    const r = inspectKeyId('sk_test_stripe_key');
    expect(r.valid).toBe(false);
    expect(r.problem).toContain('rzp_test_');
  });
  it('rejects an empty key', () => {
    expect(inspectKeyId('   ').valid).toBe(false);
  });
  it('rejects a truncated key', () => {
    expect(inspectKeyId('rzp_test_').valid).toBe(false);
  });
});
