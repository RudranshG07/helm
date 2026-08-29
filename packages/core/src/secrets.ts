import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export function deriveMasterKey(secret: string): Buffer {
  if (!secret || secret.length < 32) {
    throw new SecretError('The master key must be at least 32 characters.');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, masterKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(payload: Buffer, masterKey: Buffer): string {
  if (payload.length <= IV_BYTES + TAG_BYTES) {
    throw new SecretError('Ciphertext is too short to be valid.');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = payload.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretError('Could not decrypt. The master key is wrong or the data was tampered with.');
  }
}

export function fingerprint(keyId: string): string {
  return createHash('sha256').update(keyId, 'utf8').digest('hex').slice(0, 16);
}

export function sameFingerprint(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface KeyShape {
  valid: boolean;
  mode: 'test' | 'live' | null;
  problem: string | null;
}

export function inspectKeyId(keyId: string): KeyShape {
  const trimmed = keyId.trim();
  if (trimmed.length === 0) {
    return { valid: false, mode: null, problem: 'Key ID is empty.' };
  }
  if (trimmed.startsWith('rzp_test_')) {
    return { valid: trimmed.length > 12, mode: 'test', problem: trimmed.length > 12 ? null : 'Key ID looks truncated.' };
  }
  if (trimmed.startsWith('rzp_live_')) {
    return { valid: trimmed.length > 12, mode: 'live', problem: trimmed.length > 12 ? null : 'Key ID looks truncated.' };
  }
  return {
    valid: false,
    mode: null,
    problem: 'A Razorpay key ID starts with rzp_test_ or rzp_live_.',
  };
}
