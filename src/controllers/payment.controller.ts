import { Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/payment.service';
import { PaymentStateError, ConflictError } from '../models/payment.model';

const CreatePaymentSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3).optional(),
  orderId: z.string().optional(),
});

export const createPayment = async (req: Request, res: Response) => {
  const parsed = CreatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  try {
    const payment = await paymentService.createPayment({ ...parsed.data, idempotencyKey });
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
