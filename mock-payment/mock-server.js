/**
 * Mock Server — Payment Service
 * Simula todos los endpoints del payment-service sin BD ni RabbitMQ.
 *
 * Soporta dos métodos de pago:
 *   - SIMULATED    → flujo original: /confirm y /reject manuales.
 *   - MERCADO_PAGO → simula el flujo real de Checkout Pro de MP:
 *                    1. Se crea una "preferencia" (preferenceId + initPoint)
 *                    2. El comprador "paga" en MP → POST /api/mercadopago/simulate-payment
 *                    3. MP nos notifica → POST /api/payments/mercadopago/webhook
 *                    El estado del Payment (PENDING → APPROVED/REJECTED) SOLO
 *                    cambia a través del webhook, nunca con /confirm o /reject.
 *
 * No se llama a la API real de Mercado Pago en ningún momento (mock puro).
 *
 * Arrancar: node mock-server.js
 * Puerto:   3000
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// CORS manual (sin dependencias extra): necesario porque en Render este
// servicio es consumido cross-origin por el frontend y por los servicios
// de otros grupos (Pedidos, Notificaciones, Reportería).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── In-memory stores ────────────────────────────────────────────────────────
const payments = new Map();          // id → Payment
const idempotencyCache = new Map();  // key → { result }
const mpPreferences = new Map();     // preferenceId → { id, externalReference, initPoint }
const mpPayments = new Map();        // mpPaymentId → { id, status, externalReference, transactionAmount }
const events = [];                   // log en memoria de "eventos publicados" (no hay RabbitMQ real)

const PAYMENT_METHODS = ['SIMULATED', 'MERCADO_PAGO'];
const MP_STATUSES = ['approved', 'rejected', 'pending', 'in_process', 'cancelled'];

// ── Helpers ──────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

function publishEvent(type, payment) {
  events.push({
    type,                       // PaymentPending | PaymentApproved | PaymentRejected
    paymentId: payment.id,
    paymentMethod: payment.paymentMethod,
    orderId: payment.orderId,
    status: payment.status,
    publishedAt: now(),
  });
  // En el sistema real esto se publica en el exchange RabbitMQ "payments.events".
  console.log(`[mock] evento publicado → ${type} (payment ${payment.id})`);
}

function makePayment({ amount, currency = 'USD', orderId = null, idempotencyKey = null, paymentMethod = 'SIMULATED' }) {
  const payment = {
    id: uuidv4(),
    amount,
    currency,
    status: 'PENDING',
    paymentMethod,
    idempotencyKey,
    orderId,
    version: 0,
    createdAt: now(),
    updatedAt: now(),
    confirmedAt: null,
    rejectedAt: null,
  };

  if (paymentMethod === 'MERCADO_PAGO') {
    const preferenceId = uuidv4();
    const initPoint = `https://sandbox.mercadopago.mock/checkout/${preferenceId}`;
    mpPreferences.set(preferenceId, {
      id: preferenceId,
      externalReference: payment.id,
      initPoint,
    });
    payment.mercadoPago = {
      preferenceId,
      initPoint,
      mpPaymentId: null,
      mpStatus: null,
    };
  }

  return payment;
}

// Traduce el estado de Mercado Pago al estado interno del Payment.
// Devuelve null si el estado de MP no implica una transición todavía
// (pending / in_process se quedan en PENDING internamente).
function mapMpStatusToLocal(mpStatus) {
  if (mpStatus === 'approved') return 'APPROVED';
  if (mpStatus === 'rejected' || mpStatus === 'cancelled') return 'REJECTED';
  return null; // pending, in_process
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

// ── Routes: Payments ─────────────────────────────────────────────────────────

// POST /api/payments — crear pago (SIMULATED o MERCADO_PAGO)
app.post('/api/payments', idempotency, (req, res) => {
  const { amount, currency, orderId, paymentMethod = 'SIMULATED' } = req.body;

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: [{ message: 'Amount must be positive' }],
    });
  }

  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: [{ message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` }],
    });
  }

  const idempotencyKey = res.locals.idempotencyKey || null;
  const payment = makePayment({ amount, currency, orderId, idempotencyKey, paymentMethod });
  payments.set(payment.id, payment);

  publishEvent('PaymentPending', payment);

  return res.status(201).json(payment);
});

// GET /api/payments — listar (filtros: ?status=&orderId=&paymentMethod=)
app.get('/api/payments', (req, res) => {
  let list = Array.from(payments.values());
  if (req.query.status) {
    list = list.filter(p => p.status === req.query.status.toUpperCase());
  }
  if (req.query.orderId) {
    list = list.filter(p => p.orderId === req.query.orderId);
  }
  if (req.query.paymentMethod) {
    list = list.filter(p => p.paymentMethod === req.query.paymentMethod.toUpperCase());
  }
  return res.json(list);
});

// GET /api/payments/stats — estadísticas (globales y por método de pago)
app.get('/api/payments/stats', (req, res) => {
  const list = Array.from(payments.values());
  const byStatus = (s) => list.filter(p => p.status === s);
  const sum = (arr) => arr.reduce((acc, p) => acc + p.amount, 0);

  const byMethod = (method) => list.filter(p => p.paymentMethod === method);

  return res.json({
    total: list.length,
    pending:  { count: byStatus('PENDING').length,  totalAmount: sum(byStatus('PENDING'))  },
    approved: { count: byStatus('APPROVED').length, totalAmount: sum(byStatus('APPROVED')) },
    rejected: { count: byStatus('REJECTED').length, totalAmount: sum(byStatus('REJECTED')) },
    byPaymentMethod: {
      SIMULATED:    { count: byMethod('SIMULATED').length,    totalAmount: sum(byMethod('SIMULATED')) },
      MERCADO_PAGO: { count: byMethod('MERCADO_PAGO').length, totalAmount: sum(byMethod('MERCADO_PAGO')) },
    },
  });
});

// GET /api/payments/:id — consultar individual
app.get('/api/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });
  return res.json(payment);
});

// GET /api/payments/:id/mercadopago — detalle del sub-objeto MP de un pago
app.get('/api/payments/:id/mercadopago', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });
  if (payment.paymentMethod !== 'MERCADO_PAGO') {
    return res.status(400).json({ error: `Payment ${req.params.id} was not created with paymentMethod MERCADO_PAGO` });
  }
  return res.json(payment.mercadoPago);
});

// POST /api/payments/:id/confirm — PENDING → APPROVED (solo SIMULATED)
app.post('/api/payments/:id/confirm', idempotency, (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });

  if (payment.paymentMethod === 'MERCADO_PAGO') {
    return res.status(400).json({
      error: 'Payments with paymentMethod MERCADO_PAGO cannot be confirmed manually',
      code: 'INVALID_PAYMENT_METHOD_ACTION',
      details: [{ message: 'Use POST /api/mercadopago/simulate-payment to simulate the checkout result' }],
    });
  }

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

  publishEvent('PaymentApproved', payment);

  return res.json(payment);
});

// POST /api/payments/:id/reject — PENDING → REJECTED (solo SIMULATED)
app.post('/api/payments/:id/reject', idempotency, (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: `Payment ${req.params.id} not found` });

  if (payment.paymentMethod === 'MERCADO_PAGO') {
    return res.status(400).json({
      error: 'Payments with paymentMethod MERCADO_PAGO cannot be rejected manually',
      code: 'INVALID_PAYMENT_METHOD_ACTION',
      details: [{ message: 'Use POST /api/mercadopago/simulate-payment to simulate the checkout result' }],
    });
  }

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

  publishEvent('PaymentRejected', payment);

  return res.json(payment);
});

// ── Routes: Mercado Pago (mock) ──────────────────────────────────────────────

// POST /api/mercadopago/simulate-payment
// Simula lo que ocurre del lado de Mercado Pago cuando el comprador termina
// el checkout: crea un "pago MP" (mpPaymentId) con el resultado indicado y
// dispara el webhook automáticamente (igual que MP haría con nuestro backend).
//
// body: { preferenceId: string, result: "approved" | "rejected" | "pending" | "in_process" | "cancelled" }
app.post('/api/mercadopago/simulate-payment', (req, res) => {
  const { preferenceId, result } = req.body;

  if (!preferenceId || !mpPreferences.has(preferenceId)) {
    return res.status(404).json({ error: `Preference ${preferenceId} not found` });
  }
  if (!MP_STATUSES.includes(result)) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: [{ message: `result must be one of: ${MP_STATUSES.join(', ')}` }],
    });
  }

  const preference = mpPreferences.get(preferenceId);
  const payment = payments.get(preference.externalReference);
  if (!payment) {
    return res.status(404).json({ error: `Payment for preference ${preferenceId} not found` });
  }

  const mpPaymentId = uuidv4();
  const mpPayment = {
    id: mpPaymentId,
    status: result,
    externalReference: payment.id,
    transactionAmount: payment.amount,
    dateCreated: now(),
  };
  mpPayments.set(mpPaymentId, mpPayment);

  // MP le devuelve esto al frontend/checkout en el momento del pago.
  const simulatedMpResponse = { ...mpPayment };

  // Dispara el webhook internamente, tal como lo haría Mercado Pago en producción.
  applyMercadoPagoWebhook(mpPaymentId);

  return res.status(201).json({
    mercadoPago: simulatedMpResponse,
    payment: payments.get(payment.id),
  });
});

// POST /api/payments/mercadopago/webhook
// Endpoint que Mercado Pago llamaría en producción (IPN / webhook).
// Formato real de MP: { type: "payment", data: { id: "<mpPaymentId>" } }
// Puede llamarse manualmente para pruebas, o lo dispara /simulate-payment.
app.post('/api/payments/mercadopago/webhook', (req, res) => {
  const { type, data } = req.body;

  if (type !== 'payment' || !data || !data.id) {
    return res.status(400).json({
      error: 'Invalid webhook payload',
      details: [{ message: 'Expected { type: "payment", data: { id: "<mpPaymentId>" } }' }],
    });
  }

  const result = applyMercadoPagoWebhook(data.id);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  // MP recomienda responder 200/201 rápido para evitar reintentos.
  return res.status(200).json({ received: true, payment: result.payment });
});

// Lógica compartida: aplica el resultado de un mpPayment al Payment interno.
// Es idempotente — si el pago ya está en estado final, no reprocesa ni falla.
function applyMercadoPagoWebhook(mpPaymentId) {
  const mpPayment = mpPayments.get(mpPaymentId);
  if (!mpPayment) {
    return { ok: false, status: 404, error: `Mercado Pago payment ${mpPaymentId} not found` };
  }

  const payment = payments.get(mpPayment.externalReference);
  if (!payment) {
    return { ok: false, status: 404, error: `Payment ${mpPayment.externalReference} not found` };
  }

  // Siempre reflejamos el último estado crudo de MP para trazabilidad.
  payment.mercadoPago.mpPaymentId = mpPayment.id;
  payment.mercadoPago.mpStatus = mpPayment.status;

  // Idempotencia frente a reintentos del webhook: si ya está en estado final,
  // no se reprocesa (no lanzamos 409, para no gatillar reintentos de MP).
  if (payment.status !== 'PENDING') {
    payment.updatedAt = now();
    return { ok: true, payment };
  }

  const localStatus = mapMpStatusToLocal(mpPayment.status);
  if (!localStatus) {
    // pending / in_process: aún no hay transición de estado final.
    payment.updatedAt = now();
    return { ok: true, payment };
  }

  payment.status = localStatus;
  payment.updatedAt = now();
  payment.version += 1;

  if (localStatus === 'APPROVED') {
    payment.confirmedAt = now();
    publishEvent('PaymentApproved', payment);
  } else {
    payment.rejectedAt = now();
    publishEvent('PaymentRejected', payment);
  }

  return { ok: true, payment };
}

// ── Routes: Events (debug) ───────────────────────────────────────────────────

// GET /api/events — log en memoria de los eventos "publicados" (no hay RabbitMQ real)
app.get('/api/events', (req, res) => {
  return res.json(events);
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // En Render, PORT lo inyecta la plataforma automáticamente (no hay que
  // hardcodearlo ni tocar nada acá); local, cae al 3000 por default.
  console.log(`[mock] Payment Service corriendo en el puerto ${PORT}`);
  console.log('[mock] Endpoints disponibles:');
  console.log('  POST   /api/payments                         (paymentMethod: SIMULATED | MERCADO_PAGO)');
  console.log('  GET    /api/payments');
  console.log('  GET    /api/payments/stats');
  console.log('  GET    /api/payments/:id');
  console.log('  GET    /api/payments/:id/mercadopago');
  console.log('  POST   /api/payments/:id/confirm             (solo SIMULATED)');
  console.log('  POST   /api/payments/:id/reject              (solo SIMULATED)');
  console.log('  POST   /api/mercadopago/simulate-payment      (simula checkout de MP)');
  console.log('  POST   /api/payments/mercadopago/webhook      (simula notificación de MP)');
  console.log('  GET    /api/events                            (debug: eventos publicados)');
});
