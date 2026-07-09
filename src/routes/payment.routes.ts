import { Router } from 'express';
import { idempotencyMiddleware } from '../middlewares/idempotency.middleware';
import { requireAuth } from '../middlewares/auth.middleware';
import * as ctrl from '../controllers/payment.controller';

const router = Router();

// POST /payments — crear pago (requiere JWT válido de Grupo 2 + idempotente)
router.post('/', requireAuth, idempotencyMiddleware, ctrl.createPayment);

// GET /payments — listar todos (filtros: ?status=APPROVED&orderId=xxx)
router.get('/', ctrl.getPayments);

// GET /payments/stats — estadísticas para Grupo 10 reportería
router.get('/stats', ctrl.getPaymentStats);

// POST /payments/webhook — notificaciones de Mercado Pago (público, sin JWT:
// Mercado Pago no tiene ni puede tener un token de nuestro sistema de auth;
// se verifica con la firma propia de MP en el controller)
router.post('/webhook', ctrl.mercadoPagoWebhook);

// GET /payments/:id — consultar pago individual
router.get('/:id', ctrl.getPayment);

// POST /payments/:id/confirm — confirmar pago PENDING → APPROVED (requiere JWT + idempotente)
router.post('/:id/confirm', requireAuth, idempotencyMiddleware, ctrl.confirmPayment);

// POST /payments/:id/reject — rechazar pago PENDING → REJECTED (requiere JWT + idempotente)
router.post('/:id/reject', requireAuth, idempotencyMiddleware, ctrl.rejectPayment);

export default router;