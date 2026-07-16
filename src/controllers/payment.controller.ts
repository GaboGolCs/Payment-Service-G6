import { Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/payment.service';
import { PaymentStateError, ConflictError } from '../models/payment.model';
import { mercadoPagoService } from '../services/mercadopago.service';
import { eventConsumer } from '../events/event.consumer';

const CreatePaymentSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3).optional(),
  orderId: z.string().uuid('orderId debe ser un UUID válido (el id interno del pedido, no el order_number)').optional(),
  description: z.string().optional(),
  payerEmail: z.string().email().optional(),
});

export const createPayment = async (req: Request, res: Response) => {
  const parsed = CreatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  // req.user viene del middleware requireAuth (validado contra Grupo 2).
  // Si el body no trae payerEmail explícito, usamos el del usuario autenticado.
  const payerEmail = parsed.data.payerEmail ?? req.user?.email;

  try {
    const payment = await paymentService.createPayment({ ...parsed.data, payerEmail, idempotencyKey });
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

export const getPendingOrders = async (_req: Request, res: Response) => {
  try {
    const orders = eventConsumer.getKnownOrders();
    return res.json(orders);
  } catch (err) {
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
 *
 * Endpoint público que consume Mercado Pago para notificar cambios de
 * estado de un pago (Checkout Pro). Responde 200 lo antes posible: MP
 * reintenta agresivamente si no recibe 2xx.
 *
 * Referencia: https://www.mercadopago.com/developers -> Notificaciones webhook
 */
export const mercadoPagoWebhook = async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) || req.body?.type;
    const dataId = (req.query['data.id'] as string) || req.body?.data?.id;

    if (type !== 'payment' || !dataId) {
      // Otros tipos de notificación (merchant_order, etc.) se reconocen pero se ignoran
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
    // Igual respondemos 200 para evitar reintentos infinitos por errores no
    // recuperables (p.ej. pago ya no existe en MP); el log queda para debug.
    return res.status(200).json({ received: true, error: 'processing_error' });
  }
};