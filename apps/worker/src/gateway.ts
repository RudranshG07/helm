export interface OrderRef {
  id: string;
  receipt: string;
}

export interface PaymentRef {
  id: string;
  status: 'created' | 'authorized' | 'captured' | 'failed';
  error_reason?: string | null;
}

export interface ChargeRequest {
  receipt: string;
  amount_paise: number;
  subscription_id: string;
  rzp_subscription_id: string;
  scheduled_for: Date;
}

export class DuplicateReceiptError extends Error {
  readonly receipt: string;

  constructor(receipt: string) {
    super(`An order with receipt ${receipt} already exists`);
    this.name = 'DuplicateReceiptError';
    this.receipt = receipt;
  }
}

export interface Gateway {
  createOrderAndCharge(req: ChargeRequest): Promise<{ order: OrderRef; payment: PaymentRef | null }>;
  findOrderByReceipt(receipt: string): Promise<{ order: OrderRef; payments: PaymentRef[] } | null>;
}

export class RefusingGateway implements Gateway {
  async createOrderAndCharge(): Promise<never> {
    throw new Error('No live gateway is configured. Execution is unavailable.');
  }
  async findOrderByReceipt(): Promise<null> {
    return null;
  }
}
