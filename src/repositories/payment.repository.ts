import { PrismaClient } from '@prisma/client';
import { CreatePaymentDto } from '../models/payment.model';

const prisma = new PrismaClient();

export const paymentRepository = {
  create: async (dto: CreatePaymentDto) => {
    return prisma.payment.create({
      data: {
        amount: dto.amount,
        currency: dto.currency || 'USD',
        orderId: dto.orderId,
        idempotencyKey: dto.idempotencyKey,
        status: 'PENDING',
        version: 0,
      },
    });
  },

  findById: async (id: string) => {
    return prisma.payment.findUnique({ where: { id } });
  },

  findAll: async (filters?: { status?: string; orderId?: string }) => {
    return prisma.payment.findMany({
      where: {
        ...(filters?.status && { status: filters.status as any }),
        ...(filters?.orderId && { orderId: filters.orderId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Optimistic locking: UPDATE WHERE id=? AND version=? AND status=PENDING
   *
   * Si otra transacción ya modificó el registro (version cambió),
   * updateMany devuelve { count: 0 } → el servicio detecta la race condition.
   *
   * Ventaja sobre SELECT FOR UPDATE (pessimistic): no bloquea filas,
   * escala mejor bajo alta concurrencia.
   */
  confirmWithOptimisticLock: async (id: string, currentVersion: number) => {
    return prisma.payment.updateMany({
      where: {
        id,
        version: currentVersion,   // ← guard de race condition
        status: 'PENDING',         // ← guard de estado transaccional
      },
      data: {
        status: 'APPROVED',
        confirmedAt: new Date(),
        version: { increment: 1 },
      },
    });
  },

  rejectWithOptimisticLock: async (id: string, currentVersion: number) => {
    return prisma.payment.updateMany({
      where: {
        id,
        version: currentVersion,
        status: 'PENDING',
      },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        version: { increment: 1 },
      },
    });
  },

  stats: async () => {
    return prisma.payment.groupBy({
      by: ['status'],
      _count: { id: true },
      _sum: { amount: true },
    });
  },
};
