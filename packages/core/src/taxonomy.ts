import type { Bucket, Method } from './types.ts';

export const TAXONOMY_VERSION = '0.1.0-seed';

export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  bucket: Bucket;
  confidence: Confidence;
  matched_rule: string;
  taxonomy_version: string;
  verified: boolean;
}

export interface AttemptError {
  error_code?: string | null | undefined;
  error_reason?: string | null | undefined;
  error_source?: string | null | undefined;
  error_step?: string | null | undefined;
}

interface Entry {
  bucket: Bucket;
  confidence: Confidence;
  verified: boolean;
  methods?: Method[];
}

const REASON_MAP: Record<string, Entry> = {
  insufficient_funds:    { bucket: 'SOFT_LIQUIDITY',  confidence: 'high',   verified: false },
  payment_timed_out:     { bucket: 'SOFT_TRANSIENT',  confidence: 'high',   verified: false },
  bank_technical_error:  { bucket: 'SOFT_TRANSIENT',  confidence: 'high',   verified: false },
  partner_bank_downtime: { bucket: 'SOFT_TRANSIENT',  confidence: 'high',   verified: false },
  invalid_vpa:           { bucket: 'HARD_INSTRUMENT', confidence: 'medium', verified: false },
  payment_cancelled:     { bucket: 'HARD_CUSTOMER',   confidence: 'medium', verified: false },
};

const SOURCE_LEAN: Record<string, Bucket> = {
  issuer_bank: 'SOFT_TRANSIENT',
  gateway: 'SOFT_TRANSIENT',
  network: 'SOFT_TRANSIENT',
  beneficiary_bank: 'SOFT_TRANSIENT',
  customer_psp: 'SOFT_TRANSIENT',
  internal: 'SOFT_TRANSIENT',
  bank: 'SOFT_TRANSIENT',
};

export function isOurBug(err: AttemptError): boolean {
  return err.error_source === 'business';
}

export function classify(err: AttemptError, method: Method): Classification {
  const reason = err.error_reason?.trim().toLowerCase();

  if (reason) {
    const entry = REASON_MAP[reason];
    if (entry && (!entry.methods || entry.methods.includes(method))) {
      return {
        bucket: entry.bucket,
        confidence: entry.confidence,
        matched_rule: `reason:${reason}`,
        verified: entry.verified,
        taxonomy_version: TAXONOMY_VERSION,
      };
    }
  }

  const lean = err.error_source ? SOURCE_LEAN[err.error_source] : undefined;
  return {
    bucket: 'UNKNOWN',
    confidence: 'low',
    matched_rule: lean
      ? `unmapped:reason=${reason ?? 'null'}:source_leans=${lean}`
      : `unmapped:reason=${reason ?? 'null'}`,
    verified: false,
    taxonomy_version: TAXONOMY_VERSION,
  };
}

export function isHard(b: Bucket): boolean {
  return b === 'HARD_INSTRUMENT' || b === 'HARD_CUSTOMER';
}
