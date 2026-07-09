import { Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/payment.service';
import { PaymentStateError, ConflictError } from '../models/payment.model';
import { mercadoPagoService } from '../services/mercadopago.service';

// USA LA IMPORTACIÓN NOMBRADA (CON LLAVES):
// BUSCA ESTA LÍNEA Y DÉJALA EXACTAMENTE ASÍ:
import { eventPublisher } from '../events/event.publisher';

// ... (Todo el resto de tu controlador que corregimos antes queda igual) Importación agregada para RabbitMQ

// Esquema de validación adaptado al contrato del Grupo 5 (Pedidos)
const CreatePaymentSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3).optional(),
  orderId: z.string({ required_error: 'orderId is required from G5' }), 
  description: z.string().optional(),
  payerEmail: z.string().email().optional(),
  userId: z.string().optional(), // Captura el ID de Auth externo (ej: "felipe-04")
  orderNumber: z.string().optional()
});

export const createPayment = async (req: Request, res: Response) => {
  const parsed = CreatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  try {
    // Estructuramos el payload mapeando el userId dentro de un objeto de metadatos plano
    const payment = await paymentService.createPayment({
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      orderId: parsed.data.orderId,
      description: parsed.data.description || `Orden nro: ${parsed.data.orderNumber || 'S/N'}`,
      payerEmail: parsed.data.payerEmail,
      idempotencyKey,
      metadata: parsed.data.userId ? { userId: parsed.data.userId } : undefined
    });

    // Fila 3 del Excel: Publicamos el evento 'PaymentPending' de inmediato a RabbitMQ
    await eventPublisher.publish('PaymentPending', {
      paymentId: payment.id,
      orderId: payment.orderId,
      amount: payment.amount,
      status: payment.status
    });

    return res.status(201).json(payment);
  } catch (err) {
    console.error('[createPayment]', err);
    return res.status(500).json({ error: 'Failed to create payment' });
  }
};

export const getPayment = async (req: Request, res: Response) => {
  try {
    const payment = await paymentService.getPayment(req.params.id);
    return res.json(payment);
  } catch (err: any) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: `Payment ${req.params.id} not found` });
    }
    return res.status(500).json({ error: 'Internal error' });
  }
};

export const getPayments = async (req: Request, res: Response) => {
  const { status, orderId } = req.query;
  try {
    const payments = await paymentService.getAllPayments({
      status: status as string | undefined,
      orderId: orderId as string | undefined,
    });
    return res.json(payments);
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
};

export const confirmPayment = async (req: Request, res: Response) => {
  try {
    const payment = await paymentService.confirmPayment(req.params.id);
    return res.json(payment);
  } catch (err: any) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: `Payment ${req.params.id} not found` });
    }
    if (err instanceof PaymentStateError) {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        current_status: err.currentStatus,
      });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, code: 'RACE_CONDITION' });
    }
    console.error('[confirmPayment]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

export const rejectPayment = async (req: Request, res: Response) => {
  try {
    const payment = await paymentService.rejectPayment(req.params.id);
    return res.json(payment);
  } catch (err: any) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: `Payment ${req.params.id} not found` });
    }
    if (err instanceof PaymentStateError) {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        current_status: err.currentStatus,
      });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: err.message, code: 'RACE_CONDITION' });
    }
    console.error('[rejectPayment]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

export const getPaymentStats = async (_req: Request, res: Response) => {
  try {
    const stats = await paymentService.getStats();
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
};

/**
 * POST /api/payments/webhook
 * Consumido asíncronamente por Mercado Pago.
 */
export const mercadoPagoWebhook = async (req: Request, res: Response) => {
  // TEMPORAL: debug crudo del request entrante — quitar después
  console.log('[DEBUG webhook] query:', JSON.stringify(req.query));
  console.log('[DEBUG webhook] headers[x-signature]:', JSON.stringify(req.headers['x-signature']));
  console.log('[DEBUG webhook] headers[x-request-id]:', JSON.stringify(req.headers['x-request-id']));
  console.log('[DEBUG webhook] body:', JSON.stringify(req.body));

  try {
    const type = (req.query.type as string) || req.body?.type;
    const dataId = (req.query['data.id'] as string) || req.body?.data?.id;

    console.log('[DEBUG webhook] type resuelto:', type);
    console.log('[DEBUG webhook] dataId resuelto:', dataId);

    if (type !== 'payment' || !dataId) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const isValidSignature = mercadoPagoService.verifySignature({
      xSignature: req.headers['x-signature'] as string | undefined,
      xRequestId: req.headers['x-request-id'] as string | undefined,
      dataId: String(dataId),
    });

    if (!isValidSignature) {
      console.warn('[webhook] Firma x-signature inválida, notificación rechazada');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const result = await paymentService.handleMercadoPagoWebhook(String(dataId));
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error('[mercadoPagoWebhook]', err);
    return res.status(200).json({ received: true, error: 'processing_error' });
  }
};