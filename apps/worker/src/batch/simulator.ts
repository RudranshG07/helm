import { toIstParts } from '@mandate/core';
import { DuplicateReceiptError } from '../gateway.ts';
import type { ChargeRequest, Gateway, OrderRef, PaymentRef } from '../gateway.ts';

export interface GenerativeModel {
  payday_days: number[];
  contention_hours: number[];
  base_success: number;
  contention_penalty: number;
  amount_sensitivity: number;
  pre_payday_penalty: number;
}

export const DEFAULT_MODEL: GenerativeModel = {
  payday_days: [1, 2, 3],
  contention_hours: [0, 1, 2, 3, 4, 5],
  base_success: 0.86,
  contention_penalty: 0.55,
  amount_sensitivity: 0.35,
  pre_payday_penalty: 0.5,
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function successProbability(
  at: Date,
  amountPaise: number,
  medianPaise: number,
  model: GenerativeModel = DEFAULT_MODEL,
): number {
  const ist = toIstParts(at);
  const onPayday = model.payday_days.includes(ist.day);
  const inContentionWindow = model.contention_hours.includes(ist.hour);
  const beforePayday = ist.day >= 26 || (!onPayday && ist.day < 1);

  let p = model.base_success;

  if (onPayday && inContentionWindow) {
    const sizeRatio = medianPaise > 0 ? amountPaise / medianPaise : 1;
    const sizeEffect = 1 + model.amount_sensitivity * Math.max(0, sizeRatio - 1);
    p -= model.contention_penalty * Math.min(2, sizeEffect) * 0.5;
  }

  if (beforePayday) p -= model.pre_payday_penalty;

  return Math.min(0.99, Math.max(0.01, p));
}

export interface SimulatorOptions {
  seed?: number;
  model?: GenerativeModel;
  medianPaise: number;
}

export class SimulatedGateway implements Gateway {
  private readonly orders = new Map<string, { order: OrderRef; payments: PaymentRef[] }>();
  private readonly rand: () => number;
  private readonly model: GenerativeModel;
  private readonly medianPaise: number;
  private seq = 0;

  public readonly charges: { receipt: string; at: Date; amount_paise: number; succeeded: boolean; p: number }[] = [];

  constructor(options: SimulatorOptions) {
    this.rand = mulberry32(options.seed ?? 42);
    this.model = options.model ?? DEFAULT_MODEL;
    this.medianPaise = options.medianPaise;
  }

  async createOrderAndCharge(req: ChargeRequest): Promise<{ order: OrderRef; payment: PaymentRef | null }> {
    if (this.orders.has(req.receipt)) throw new DuplicateReceiptError(req.receipt);

    const p = successProbability(req.scheduled_for, req.amount_paise, this.medianPaise, this.model);
    const succeeded = this.rand() < p;

    this.seq += 1;
    const order: OrderRef = { id: `order_sim_${this.seq}`, receipt: req.receipt };
    const payment: PaymentRef = {
      id: `pay_sim_${this.seq}`,
      status: succeeded ? 'captured' : 'failed',
      error_reason: succeeded ? null : 'insufficient_funds',
    };

    this.orders.set(req.receipt, { order, payments: [payment] });
    this.charges.push({ receipt: req.receipt, at: req.scheduled_for, amount_paise: req.amount_paise, succeeded, p });

    return { order, payment };
  }

  async findOrderByReceipt(receipt: string) {
    return this.orders.get(receipt) ?? null;
  }

  get attemptsMade(): number {
    return this.charges.length;
  }

  get recoveredPaise(): number {
    return this.charges.filter((c) => c.succeeded).reduce((sum, c) => sum + c.amount_paise, 0);
  }
}
