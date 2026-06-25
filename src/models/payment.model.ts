export type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey?: string | null;
  orderId?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt?: Date | null;
  rejectedAt?: Date | null;
}

export interface CreatePaymentDto {
  amount: number;
  currency?: string;
  orderId?: string;
  idempotencyKey?: string;
}

export class PaymentStateError extends Error {
  constructor(
    public readonly code: string,
    public readonly currentStatus: PaymentStatus,
    message: string
  ) {
    super(message);
    this.name = 'PaymentStateError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
