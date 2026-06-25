import { paymentRepository } from '../repositories/payment.repository';
import { eventPublisher } from '../events/event.publisher';
import { CreatePaymentDto, PaymentStateError, ConflictError } from '../models/payment.model';

export const paymentService = {
  /**
   * POST /payments
   * Crea un pago en estado PENDING y publica evento PaymentPending.
   */
  createPayment: async (dto: CreatePaymentDto) => {
    const payment = await paymentRepository.create(dto);

    // Eventual consistency: Grupo 9 (notificaciones) recibirá este evento
    await eventPublisher.publish('PaymentPending', {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      orderId: payment.orderId,
    });

    return payment;
  },

  /**
   * GET /payments/:id
   */
  getPayment: async (id: string) => {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new Error('NOT_FOUND');
    return payment;
  },

  getAllPayments: async (filters?: { status?: string; orderId?: string }) => {
    return paymentRepository.findAll(filters);
  },

  /**
   * POST /payments/:id/confirm
   *
   * Patrones aplicados:
   * 1. Estado transaccional: solo PENDING puede confirmarse
   * 2. Optimistic locking: UPDATE WHERE version=N previene doble procesamiento
   * 3. Idempotencia: manejada en el middleware (Redis)
   * 4. Eventual consistency: evento publicado tras commit exitoso
   */
  confirmPayment: async (id: string) => {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new Error('NOT_FOUND');

    // Guard de estado transaccional
    if (payment.status !== 'PENDING') {
      throw new PaymentStateError(
        'ALREADY_PROCESSED',
        payment.status,
        `Payment ${id} is already in final state: ${payment.status}`
      );
    }

    // Optimistic locking — si count === 0 hubo race condition
    const result = await paymentRepository.confirmWithOptimisticLock(id, payment.version);

    if (result.count === 0) {
      throw new ConflictError(
        `Payment ${id} was modified by a concurrent process. Retry or check current state.`
      );
    }

    const updated = await paymentRepository.findById(id);

    // Grupos 5 (pedidos) y 10 (reportería) recibirán este evento
    await eventPublisher.publish('PaymentApproved', {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      confirmedAt: updated!.confirmedAt?.toISOString(),
    });

    return updated;
  },

  /**
   * POST /payments/:id/reject
   * Mismos patrones que confirmPayment pero transición → REJECTED
   */
  rejectPayment: async (id: string) => {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new Error('NOT_FOUND');

    if (payment.status !== 'PENDING') {
      throw new PaymentStateError(
        'ALREADY_PROCESSED',
        payment.status,
        `Payment ${id} is already in final state: ${payment.status}`
      );
    }

    const result = await paymentRepository.rejectWithOptimisticLock(id, payment.version);

    if (result.count === 0) {
      throw new ConflictError(
        `Payment ${id} was modified by a concurrent process. Retry or check current state.`
      );
    }

    const updated = await paymentRepository.findById(id);

    // Grupos 9 (notificaciones) y 10 (reportería) recibirán este evento
    await eventPublisher.publish('PaymentRejected', {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      rejectedAt: updated!.rejectedAt?.toISOString(),
    });

    return updated;
  },

  getStats: async () => {
    return paymentRepository.stats();
  },
};
