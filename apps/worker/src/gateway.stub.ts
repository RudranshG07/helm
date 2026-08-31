import { randomBytes } from 'node:crypto';
import { DuplicateReceiptError } from './gateway.ts';
import type { ChargeRequest, Gateway, OrderRef, PaymentRef } from './gateway.ts';

export interface StubOptions {
  paymentStatus?: PaymentRef['status'];
  failWith?: Error;
}

export class StubGateway implements Gateway {
  public readonly createCalls: ChargeRequest[] = [];
  public readonly lookupCalls: string[] = [];
  private readonly orders = new Map<string, { order: OrderRef; payments: PaymentRef[] }>();
  private seq = 0;
  private readonly run = randomBytes(4).toString('hex');

  private readonly options: StubOptions;

  constructor(options: StubOptions = {}) {
    this.options = options;
  }

  get ordersCreated(): number {
    return this.orders.size;
  }

  async createOrderAndCharge(req: ChargeRequest): Promise<{ order: OrderRef; payment: PaymentRef | null }> {
    this.createCalls.push(req);

    if (this.orders.has(req.receipt)) {
      throw new DuplicateReceiptError(req.receipt);
    }
    if (this.options.failWith) {
      throw this.options.failWith;
    }

    this.seq += 1;
    const order: OrderRef = { id: `order_stub_${this.run}_${this.seq}`, receipt: req.receipt };
    const status = this.options.paymentStatus ?? 'captured';
    const payment: PaymentRef = { id: `pay_stub_${this.run}_${this.seq}`, status };

    this.orders.set(req.receipt, { order, payments: [payment] });
    return { order, payment };
  }

  async findOrderByReceipt(receipt: string) {
    this.lookupCalls.push(receipt);
    return this.orders.get(receipt) ?? null;
  }

  forgetPayments(receipt: string): void {
    const entry = this.orders.get(receipt);
    if (entry) entry.payments = [];
  }
}
