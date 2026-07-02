export type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  idempotencyKey?: string | null;
  orderId?: string | null;
  description?: string | null;
  payerEmail?: string | null;
  version: number;
  mpPreferenceId?: string | null;
  mpPaymentId?: string | null;
  initPoint?: string | null;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt?: Date | null;
  rejectedAt?: Date | null;
}

export interface CreatePaymentDto {
  amount: number;
  currency?: string;
  orderId?: string;
  description?: string;
  payerEmail?: string;
  idempotencyKey?: string;
}

/** Estados de pago que reporta la API de Mercado Pago */
export type MercadoPagoStatus =
  | 'pending'
  | 'approved'
  | 'authorized'
  | 'in_process'
  | 'in_mediation'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
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
