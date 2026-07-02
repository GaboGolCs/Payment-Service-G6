/**
 * Mock Server — Payment Service
 * Simula todos los endpoints del payment-service sin BD ni RabbitMQ.
 *
 * Arrancar: node mock-server.js
 * Puerto:   3000
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ── In-memory store ─────────────────────────────────────────────────────────
const payments = new Map();          // id → Payment
const idempotencyCache = new Map();  // key → { paymentId, result }

// ── Helpers ──────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

function makePayment({ amount, currency = 'USD', orderId = null, idempotencyKey = null }) {
  return {
    id: uuidv4(),
    amount,
    currency,
    status: 'PENDING',
    idempotencyKey,
    orderId,
    version: 0,
    createdAt: now(),
    updatedAt: now(),
    confirmedAt: null,
    rejectedAt: null,
  };
}

// Idempotency middleware (solo para rutas POST que lo necesiten)
function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();
  if (idempotencyCache.has(key)) {
    const cached = idempotencyCache.get(key);
    return res.status(200).json(cached.result);
  }
  res.locals.idempotencyKey = key;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    idempotencyCache.set(key, { result: body });
    return originalJson(body);
  };
  next();
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/payments — crear pago
app.post('/api/payments', idempotency, (req, res) => {
  const { amount, currency, orderId } = req.body;
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: [{ message: 'Amount must be positive' }],
    });
  }
  const idempotencyKey = res.locals.idempotencyKey || null;
  const payment = makePayment({ amount, currency, orderId, idempotencyKey });
  payments.set(payment.id, payment);
  return res.status(201).json(payment);
});

// GET /api/payments — listar (filtros: ?status=&orderId=)
app.get('/api/payments', (req, res) => {
  let list = Array.from(payments.values());
  if (req.query.status) {
    list = list.filter(p => p.status === req.query.status.toUpperCase());
  }
  if (req.query.orderId) {
    list = list.filter(p => p.orderId === req.query.orderId);
  }
  return res.json(list);
});

// GET /api/payments/stats — estadísticas
app.get('/api/payments/stats', (req, res) => {
  const list = Array.from(payments.values());
  const byStatus = (s) => list.filter(p => p.status === s);
  const sum = (arr) => arr.reduce((acc, p) => acc + p.amount, 0);
  return res.json({
    total: list.length,
    pending:  { count: byStatus('PENDING').length,  totalAmount: sum(byStatus('PENDING'))  },
    approved: { count: byStatus('APPROVED').length, totalAmount: sum(byStatus('APPROVED')) },
    rejected: { count: byStatus('REJECTED').length, totalAmount: sum(byStatus('REJECTED')) },
  });
});

// GET /api/payments/:id — consultar individual
app.get('/api/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });
  return res.json(payment);
});

// POST /api/payments/:id/confirm — PENDING → APPROVED
app.post('/api/payments/:id/confirm', idempotency, (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });
  if (payment.status !== 'PENDING') {
    return res.status(409).json({
      error: `Cannot confirm payment in status ${payment.status}`,
      code: 'INVALID_STATE_TRANSITION',
      current_status: payment.status,
    });
  }
  payment.status = 'APPROVED';
  payment.confirmedAt = now();
  payment.updatedAt = now();
  payment.version += 1;
  return res.json(payment);
});

// POST /api/payments/:id/reject — PENDING → REJECTED
app.post('/api/payments/:id/reject', idempotency, (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });
  if (payment.status !== 'PENDING') {
    return res.status(409).json({
      error: `Cannot reject payment in status ${payment.status}`,
      code: 'INVALID_STATE_TRANSITION',
      current_status: payment.status,
    });
  }
  payment.status = 'REJECTED';
  payment.rejectedAt = now();
  payment.updatedAt = now();
  payment.version += 1;
  return res.json(payment);
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[mock] Payment Service corriendo en http://localhost:${PORT}`);
  console.log('[mock] Endpoints disponibles:');
  console.log('  POST   /api/payments');
  console.log('  GET    /api/payments');
  console.log('  GET    /api/payments/stats');
  console.log('  GET    /api/payments/:id');
  console.log('  POST   /api/payments/:id/confirm');
  console.log('  POST   /api/payments/:id/reject');
});
