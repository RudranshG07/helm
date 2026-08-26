import { describe, expect, it } from 'vitest';
import { TAXONOMY_VERSION, classify, isHard, isOurBug } from './taxonomy.ts';

describe('classify', () => {
  it.each([
    ['insufficient_funds', 'SOFT_LIQUIDITY'],
    ['payment_timed_out', 'SOFT_TRANSIENT'],
    ['bank_technical_error', 'SOFT_TRANSIENT'],
    ['partner_bank_downtime', 'SOFT_TRANSIENT'],
    ['invalid_vpa', 'HARD_INSTRUMENT'],
    ['payment_cancelled', 'HARD_CUSTOMER'],
  ])('%s -> %s', (reason, bucket) => {
    expect(classify({ error_reason: reason }, 'upi_autopay').bucket).toBe(bucket);
  });

  it('a code we have never seen goes to UNKNOWN, not to a guess', () => {
    const c = classify({ error_reason: 'a_code_we_invented' }, 'upi_autopay');
    expect(c.bucket).toBe('UNKNOWN');
    expect(c.confidence).toBe('low');
  });

  it('records the source lean on an unmapped code without letting it decide the bucket', () => {
    const c = classify({ error_reason: 'mystery', error_source: 'issuer_bank' }, 'upi_autopay');
    expect(c.bucket).toBe('UNKNOWN');
    expect(c.matched_rule).toContain('source_leans=SOFT_TRANSIENT');
  });

  it('carries the taxonomy version so a backtest can be replayed against it', () => {
    expect(classify({ error_reason: 'insufficient_funds' }, 'upi_autopay').taxonomy_version)
      .toBe(TAXONOMY_VERSION);
  });

  it('names the matched entry, so a merchant can be told which rule stopped the retry', () => {
    expect(classify({ error_reason: 'invalid_vpa' }, 'upi_autopay').matched_rule)
      .toBe('reason:invalid_vpa');
  });

  it('marks every seed row unverified until real data confirms it', () => {
    expect(classify({ error_reason: 'insufficient_funds' }, 'upi_autopay').verified).toBe(false);
  });

  it('is case and whitespace insensitive on the reason', () => {
    expect(classify({ error_reason: '  Insufficient_Funds ' }, 'upi_autopay').bucket)
      .toBe('SOFT_LIQUIDITY');
  });

  it.each([
    [{}],
    [{ error_reason: null }],
    [{ error_reason: '' }],
    [{ error_reason: undefined, error_source: undefined }],
    [{ error_code: 'GATEWAY_ERROR' }],
  ])('never throws and never returns undefined on %j', (err) => {
    const c = classify(err, 'upi_autopay');
    expect(c).toBeDefined();
    expect(c.bucket).toBe('UNKNOWN');
  });
});

describe('isOurBug', () => {
  it('flags error_source business as our malformed request, not a decline', () => {
    expect(isOurBug({ error_source: 'business' })).toBe(true);
  });
  it('does not flag a customer-side failure', () => {
    expect(isOurBug({ error_source: 'customer' })).toBe(false);
  });
});

describe('isHard', () => {
  it.each([['HARD_INSTRUMENT', true], ['HARD_CUSTOMER', true], ['SOFT_LIQUIDITY', false], ['UNKNOWN', false]] as const)
    ('%s -> %s', (b, expected) => expect(isHard(b)).toBe(expected));
});
