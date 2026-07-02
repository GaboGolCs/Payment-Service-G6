import { paymentRepository } from '../repositories/payment.repository';
import { eventPublisher } from '../events/event.publisher';
import { CreatePaymentDto, PaymentStateError, ConflictError } from '../models/payment.model';
import { env } from '../config/env';
import { mercadoPagoService, mapMercadoPagoStatus } from './mercadopago.service';

export const paymentService = {
  /**
   * POST /payments
   * Crea un pago en estado PENDING, genera la preferencia de Checkout Pro
   * en Mercado Pago (init_point que Grupo 5/Grupo 1 usan para redirigir al
   * usuario a la pasarela) y publica el evento PaymentPending.
   */
  createPayment: async (dto: CreatePaymentDto) => {
    let payment = await paymentRepository.create(dto);

    // Eventual consistency: Grupo 9 (notificaciones) recibirá este evento
    await eventPublisher.publish('PaymentPending', {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      orderId: payment.orderId,
    });

    if (env.MP_ACCESS_TOKEN) {
      try {
        const { preferenceId, initPoint } = await mercadoPagoService.createPreference({
          paymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          description: payment.description || undefined,
          payerEmail: payment.payerEmail || undefined,
        });
        payment = await paymentRepository.attachMercadoPagoPreference(payment.id, preferenceId, initPoint);
      } catch (err) {
        // El pago ya quedó registrado (PENDING); Grupo 5 puede reintentar la
        // obtención del init_point sin duplicar el registro.
        console.error('[createPayment] Error creando preferencia en Mercado Pago:', err);
      }
    } else {
      console.warn('[createPayment] MP_ACCESS_TOKEN no configurado: se omite creación de preferencia (modo dev/test)');
    }

    return payment;
  },

  /**
   * POST /payments/webhook
   *
   * Mercado Pago solo envía `{ type, data: { id } }`; NUNCA se confía en un
   * status embebido en el body. Siempre se re-consulta el pago real contra
   * la API de Mercado Pago usando ese id, y se resuelve nuestro Payment por
   * `external_reference` (que es nuestro Payment.id).
   *
   * Idempotente: si el pago ya está en estado final, se responde 200 sin
   * reprocesar ni volver a publicar el evento (Mercado Pago reintenta
   * notificaciones agresivamente).
   */
  handleMercadoPagoWebhook: async (mpPaymentId: string) => {
    const mpPayment = await mercadoPagoService.getPayment(mpPaymentId);
    const externalReference = mpPayment.external_reference;
    const mpStatus = mpPayment.status;

    if (!externalReference) {
      console.warn(`[webhook] Pago MP ${mpPaymentId} sin external_reference, se ignora`);
      return { ignored: true };
    }

    const payment = await paymentRepository.findById(externalReference);
    if (!payment) {
      console.warn(`[webhook] Payment ${externalReference} no encontrado (mpPaymentId=${mpPaymentId})`);
      return { ignored: true };
    }

    // Ya procesado (idempotencia ante reintentos de MP)
    if (payment.status !== 'PENDING') {
      return { ignored: true, alreadyProcessed: true };
    }

    const target = mapMercadoPagoStatus(mpStatus || 'pending');
    if (target === 'PENDING') {
      // in_process / authorized / etc: aún no hay nada que aplicar
      return { ignored: true, mpStatus };
    }

    const result = await paymentRepository.applyMercadoPagoTransition(
      payment.id,
      payment.version,
      target,
      String(mpPaymentId)
    );

    if (result.count === 0) {
      // Carrera con otra actualización concurrente (p.ej. doble notificación
      // casi simultánea): no es un error, simplemente no hay nada que hacer.
      return { ignored: true, raceCondition: true };
    }

    const updated = await paymentRepository.findById(payment.id);
    const eventName = target === 'APPROVED' ? 'PaymentApproved' : 'PaymentRejected';

    // Grupos 5/9/10 según el evento (ver tabla de routing keys en event.publisher)
    await eventPublisher.publish(eventName, {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      mpPaymentId,
      confirmedAt: updated!.confirmedAt?.toISOString(),
      rejectedAt: updated!.rejectedAt?.toISOString(),
    });

    return { ignored: false, payment: updated };
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
