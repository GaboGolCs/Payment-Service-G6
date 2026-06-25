import { Router } from 'express';
import { idempotencyMiddleware } from '../middlewares/idempotency.middleware';
import * as ctrl from '../controllers/payment.controller';

const router = Router();

// POST /payments — crear pago (idempotente con Idempotency-Key header)
router.post('/', idempotencyMiddleware, ctrl.createPayment);

// GET /payments — listar todos (filtros: ?status=APPROVED&orderId=xxx)
router.get('/', ctrl.getPayments);

// GET /payments/stats — estadísticas para Grupo 10 reportería
router.get('/stats', ctrl.getPaymentStats);

// GET /payments/:id — consultar pago individual
router.get('/:id', ctrl.getPayment);

// POST /payments/:id/confirm — confirmar pago PENDING → APPROVED (idempotente)
router.post('/:id/confirm', idempotencyMiddleware, ctrl.confirmPayment);

// POST /payments/:id/reject — rechazar pago PENDING → REJECTED (idempotente)
router.post('/:id/reject', idempotencyMiddleware, ctrl.rejectPayment);

export default router;
