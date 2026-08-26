import { describe, expect, it } from 'vitest';
import { normalize } from './normalize.js';

const pendingEvent = {
  event: 'subscription.pending',
  account_id: 'acc_test',
  contains: ['subscription', 'payment'],
  payload: {
    subscription: {
      entity: {
        id: 'sub_ABC123',
        customer_id: 'cust_XYZ',
        plan_id: 'plan_monthly',
        status: 'pending',
        current_start: 1_788_220_800,
        current_end: 1_819_756_800,
        charge_at: 1_819_756_800,
        end_at: 1_819_756_800,
        payment_method: 'upi',
      },
    },
    payment: {
      entity: {
        id: 'pay_FAIL1',
        order_id: 'order_1',
        status: 'failed',
        amount: 49900,
        method: 'upi',
        created_at: 1_788_224_400,
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed due to insufficient funds',
        error_source: 'customer',
        error_step: 'payment_authentication',
        error_reason: 'insufficient_funds',
        bank: 'HDFC',
      },
    },
  },
  created_at: 1_788_224_400,
};

describe('normalize', () => {
  it('extracts the subscription from a pending event', () => {
    const { subscription } = normalize(pendingEvent);
    expect(subscription).toMatchObject({
      rzp_subscription_id: 'sub_ABC123',
      customer_ref: 'cust_XYZ',
      method: 'upi_autopay',
      status: 'pending',
    });
    expect(subscription?.current_start?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('extracts the payment error fields the taxonomy needs', () => {
    const { attempt } = normalize(pendingEvent);
    expect(attempt).toMatchObject({
      rzp_payment_id: 'pay_FAIL1',
      status: 'failed',
      amount_paise: 49900,
      error_reason: 'insufficient_funds',
      error_source: 'customer',
      error_step: 'payment_authentication',
    });
  });

  it('maps payment method strings onto our method enum', () => {
    for (const [given, expected] of [
      ['upi', 'upi_autopay'],
      ['card', 'card'],
      ['emandate', 'emandate'],
      ['nach', 'emandate'],
    ] as const) {
      const evt = {
        ...pendingEvent,
        payload: {
          ...pendingEvent.payload,
          payment: { entity: { ...pendingEvent.payload.payment.entity, method: given } },
        },
      };
      expect(normalize(evt).subscription?.method).toBe(expected);
    }
  });

  it('handles an event with a subscription but no payment', () => {
    const evt = { ...pendingEvent, payload: { subscription: pendingEvent.payload.subscription } };
    const out = normalize(evt);
    expect(out.subscription).not.toBeNull();
    expect(out.attempt).toBeNull();
  });

  it('maps an unrecognised payment status to unknown rather than throwing', () => {
    const evt = {
      ...pendingEvent,
      payload: {
        ...pendingEvent.payload,
        payment: { entity: { ...pendingEvent.payload.payment.entity, status: 'something_new' } },
      },
    };
    expect(normalize(evt).attempt?.status).toBe('unknown');
  });

  it('survives every degenerate payload shape', () => {
    const shapes: unknown[] = [
      {},
      { event: 'subscription.pending' },
      { event: 'x', payload: {} },
      { event: 'x', payload: { subscription: {} } },
      { event: 'x', payload: { subscription: { entity: {} } } },
      { event: 'x', payload: { payment: { entity: { amount: 'not a number' } } } },
      { payload: { subscription: { entity: { id: 'sub_1', current_start: -1 } } } },
    ];
    for (const shape of shapes) {
      const out = normalize(shape as never);
      expect(out).toBeDefined();
      expect(typeof out.event).toBe('string');
    }
  });

  it('drops a subscription entity that has no id', () => {
    const evt = { event: 'x', payload: { subscription: { entity: { status: 'pending' } } } };
    expect(normalize(evt).subscription).toBeNull();
  });
});
