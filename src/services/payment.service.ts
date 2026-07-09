import { paymentRepository } from '../repositories/payment.repository';
import { CreatePaymentDto, PaymentStateError, ConflictError } from '../models/payment.model';
import { env } from '../config/env';
import { mercadoPagoService, mapMercadoPagoStatus } from './mercadopago.service';

// USA LA IMPORTACIÓN NOMBRADA (CON LLAVES):
// BUSCA ESTA LÍNEA Y DÉJALA EXACTAMENTE ASÍ:
import { eventPublisher } from '../events/event.publisher';

export const paymentService = {
  /**
   * POST /payments
   * Crea un pago en estado PENDING, genera la preferencia de Checkout Pro
   * en Mercado Pago e incluye la información del userId/metadata en el evento.
   */
  createPayment: async (dto: CreatePaymentDto & { metadata?: Record<string, unknown> }) => {
    let payment = await paymentRepository.create(dto);

    // Eventual consistency: Grupo 5 y Grupo 9 recibirán este evento incluyendo la metadata/userId
    await eventPublisher.publish('PaymentPending', {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      orderId: payment.orderId,
      metadata: payment.metadata || dto.metadata || {}
    });

    if (env.MP_ACCESS_TOKEN) {
      try {
        const { preferenceId, initPoint, sandboxInitPoint } = await mercadoPagoService.createPreference({
          paymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          description: payment.description || undefined,
          payerEmail: payment.payerEmail || undefined,
        });
        console.log('[DEBUG preference] initPoint (producción, NO usar en pruebas):', initPoint);
        console.log('[DEBUG preference] sandboxInitPoint (usar este para probar):', sandboxInitPoint);
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
   * Escucha asíncronamente las actualizaciones automáticas provenientes de Mercado Pago.
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
      return { ignored: true, mpStatus };
    }

    const result = await paymentRepository.applyMercadoPagoTransition(
      payment.id,
      payment.version,
      target,
      String(mpPaymentId)
    );

    if (result.count === 0) {
      return { ignored: true, raceCondition: true };
    }

    const updated = await paymentRepository.findById(payment.id);
    const eventName = target === 'APPROVED' ? 'PaymentApproved' : 'PaymentRejected';

    // Se publica el resultado adjuntando la metadata con el userId original
    await eventPublisher.publish(eventName, {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      mpPaymentId,
      confirmedAt: updated!.confirmedAt?.toISOString(),
      rejectedAt: updated!.rejectedAt?.toISOString(),
      metadata: updated!.metadata || {}
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
   * Fuerza/Simula manualmente la aprobación de un pago usando Optimistic Locking
   */
  confirmPayment: async (id: string) => {
    const payment = await paymentRepository.findById(id);
    if (!payment) throw new Error('NOT_FOUND');

    if (payment.status !== 'PENDING') {
      throw new PaymentStateError(
        'ALREADY_PROCESSED',
        payment.status,
        `Payment ${id} is already in final state: ${payment.status}`
      );
    }

    const result = await paymentRepository.confirmWithOptimisticLock(id, payment.version);

    if (result.count === 0) {
      throw new ConflictError(
        `Payment ${id} was modified by a concurrent process. Retry or check current state.`
      );
    }

    const updated = await paymentRepository.findById(id);

    // Fila 4 del Excel: El Grupo 5 (Pedidos) escucha este evento para pasar la orden a 'PAID'
    await eventPublisher.publish('PaymentApproved', {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      confirmedAt: updated!.confirmedAt?.toISOString(),
      metadata: updated!.metadata || {}
    });

    return updated;
  },

  /**
   * POST /payments/:id/reject
   * Fuerza/Simula el rechazo de un pago.
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

    // Fila 4 del Excel de cancelaciones: Notifica al Grupo 5 para pasar a 'CANCELLED'
    await eventPublisher.publish('PaymentRejected', {
      paymentId: updated!.id,
      amount: updated!.amount,
      currency: updated!.currency,
      orderId: updated!.orderId,
      rejectedAt: updated!.rejectedAt?.toISOString(),
      metadata: updated!.metadata || {}
    });

    return updated;
  },

  getStats: async () => {
    return paymentRepository.stats();
  },
};