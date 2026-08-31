import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES, buildMessage, resolveLanguage } from './messages.ts';

const input = {
  customer_ref: 'Ravi',
  merchant_name: 'Tiffin Co',
  amount_paise: 49900,
  link: 'https://helm.test/r/abc',
};

describe('a recovery message speaks the customer language', () => {
  it.each(SUPPORTED_LANGUAGES)('%s carries the amount, the merchant and the link', (lang) => {
    const m = buildMessage(input, lang);
    expect(m.body).toContain('₹499');
    expect(m.body).toContain('Tiffin Co');
    expect(m.body).toContain(input.link);
    expect(m.subject.length).toBeGreaterThan(0);
  });

  it.each(SUPPORTED_LANGUAGES)('%s always offers a way to stop', (lang) => {
    const m = buildMessage(input, lang);
    const stop = /cancel|रद्द|band|Band/.test(m.body);
    expect(stop).toBe(true);
  });

  it.each(SUPPORTED_LANGUAGES)('%s always offers the promise-to-pay option', (lang) => {
    const m = buildMessage(input, lang);
    const promise = /date|तारीख/.test(m.body);
    expect(promise).toBe(true);
  });

  it('writes Hinglish in Latin script, not Devanagari', () => {
    const m = buildMessage(input, 'hinglish');
    expect(m.body).toContain('Namaste');
    expect(/[ऀ-ॿ]/.test(m.body)).toBe(false);
  });

  it('writes Hindi in Devanagari', () => {
    const m = buildMessage(input, 'hi');
    expect(/[ऀ-ॿ]/.test(m.body)).toBe(true);
  });

  it('never promises the customer anything about their money it cannot keep', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const m = buildMessage(input, lang);
      expect(m.body.toLowerCase()).not.toContain('refund');
      expect(m.body.toLowerCase()).not.toContain('guarantee');
    }
  });
});

describe('language selection never throws on bad input', () => {
  it.each([['hi', 'hi'], ['hindi', 'hi'], ['hinglish', 'hinglish'], ['en-hi', 'hinglish'],
           ['en', 'en'], ['', 'en'], ['klingon', 'en']] as const)
    ('%j -> %s', (input, expected) => {
      expect(resolveLanguage(input)).toBe(expected);
    });

  it('handles null and undefined', () => {
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage(undefined)).toBe('en');
  });

  it('falls back to English for an unknown language rather than sending nothing', () => {
    const m = buildMessage(input, 'klingon' as never);
    expect(m.body).toContain('Hello');
  });
});
