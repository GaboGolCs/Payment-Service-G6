/**
 * test-flow.js — Smoke test del mock Payment Service.
 *
 * Requiere el mock corriendo en otra terminal:
 *   npm start
 *
 * Luego, en esta terminal:
 *   node test-flow.js
 *
 * Requiere Node 18+ (usa fetch nativo).
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

function ok(label, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.log(`❌ ${label} ${extra}`);
  }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function run() {
  console.log(`\n== Testeando mock en ${BASE} ==\n`);

  // ── 1. Validaciones básicas ────────────────────────────────────────────
  const invalidAmount = await post('/api/payments', { amount: -5 });
  ok('rechaza amount negativo (400)', invalidAmount.status === 400);

  const invalidMethod = await post('/api/payments', { amount: 100, paymentMethod: 'BITCOIN' });
  ok('rechaza paymentMethod inválido (400)', invalidMethod.status === 400);

  // ── 2. Flujo SIMULATED (no debe romperse con los cambios) ─────────────
  const sim = await post('/api/payments', { amount: 1000, currency: 'CLP', orderId: 'ORD-SIM-1' });
  ok('crea pago SIMULATED (201)', sim.status === 201 && sim.json.status === 'PENDING');
  ok('paymentMethod default = SIMULATED', sim.json.paymentMethod === 'SIMULATED');

  const simConfirm = await post(`/api/payments/${sim.json.id}/confirm`);
  ok('confirma pago SIMULATED (APPROVED)', simConfirm.status === 200 && simConfirm.json.status === 'APPROVED');

  const simDoubleConfirm = await post(`/api/payments/${sim.json.id}/confirm`);
  ok('re-confirmar pago ya APPROVED da 409', simDoubleConfirm.status === 409);

  // ── 3. Idempotencia en creación ────────────────────────────────────────
  const idKey = 'test-key-' + Date.now();
  const first = await post('/api/payments', { amount: 500, orderId: 'ORD-IDEMP' }, { 'Idempotency-Key': idKey });
  const second = await post('/api/payments', { amount: 999999, orderId: 'OTRO' }, { 'Idempotency-Key': idKey });
  ok('misma Idempotency-Key retorna el mismo pago', first.json.id === second.json.id);

  // ── 4. Flujo MERCADO_PAGO — caso APPROVED ──────────────────────────────
  const mp = await post('/api/payments', {
    amount: 5000, currency: 'CLP', orderId: 'ORD-MP-1', paymentMethod: 'MERCADO_PAGO',
  });
  ok('crea pago MERCADO_PAGO (201) con preferencia', mp.status === 201 && !!mp.json.mercadoPago?.preferenceId);

  const mpConfirmBlocked = await post(`/api/payments/${mp.json.id}/confirm`);
  ok('bloquea /confirm manual en pago MERCADO_PAGO (400)', mpConfirmBlocked.status === 400);

  const mpReject = await post(`/api/payments/${mp.json.id}/reject`);
  ok('bloquea /reject manual en pago MERCADO_PAGO (400)', mpReject.status === 400);

  const simulateApproved = await post('/api/mercadopago/simulate-payment', {
    preferenceId: mp.json.mercadoPago.preferenceId,
    result: 'approved',
  });
  ok('simula checkout aprobado en MP (201)', simulateApproved.status === 201);
  ok('el pago pasa a APPROVED tras el webhook', simulateApproved.json.payment.status === 'APPROVED');

  const mpDetail = await get(`/api/payments/${mp.json.id}/mercadopago`);
  ok('GET /mercadopago devuelve mpStatus=approved', mpDetail.json.mpStatus === 'approved');

  // ── 5. Flujo MERCADO_PAGO — caso REJECTED ──────────────────────────────
  const mp2 = await post('/api/payments', {
    amount: 3000, currency: 'CLP', orderId: 'ORD-MP-2', paymentMethod: 'MERCADO_PAGO',
  });
  const simulateRejected = await post('/api/mercadopago/simulate-payment', {
    preferenceId: mp2.json.mercadoPago.preferenceId,
    result: 'rejected',
  });
  ok('el pago pasa a REJECTED tras el webhook', simulateRejected.json.payment.status === 'REJECTED');

  // ── 6. Flujo MERCADO_PAGO — caso PENDING (no debe transicionar) ───────
  const mp3 = await post('/api/payments', {
    amount: 2000, currency: 'CLP', orderId: 'ORD-MP-3', paymentMethod: 'MERCADO_PAGO',
  });
  const simulatePending = await post('/api/mercadopago/simulate-payment', {
    preferenceId: mp3.json.mercadoPago.preferenceId,
    result: 'pending',
  });
  ok('result=pending NO cambia el status interno', simulatePending.json.payment.status === 'PENDING');
  ok('pero sí actualiza mpStatus', simulatePending.json.payment.mercadoPago.mpStatus === 'pending');

  // ── 7. Webhook manual directo + idempotencia del webhook ──────────────
  const mpPaymentId = simulateApproved.json.mercadoPago.id;
  const webhookRetry = await post('/api/payments/mercadopago/webhook', {
    type: 'payment',
    data: { id: mpPaymentId },
  });
  ok('reintento de webhook sobre pago ya APPROVED responde 200 sin error', webhookRetry.status === 200);

  const badWebhook = await post('/api/payments/mercadopago/webhook', { type: 'payment', data: {} });
  ok('webhook con payload inválido responde 400', badWebhook.status === 400);

  // ── 8. Stats y listados ─────────────────────────────────────────────────
  const stats = await get('/api/payments/stats');
  ok('stats trae desglose byPaymentMethod', !!stats.json.byPaymentMethod?.MERCADO_PAGO);

  const filtered = await get('/api/payments?paymentMethod=MERCADO_PAGO');
  ok('filtro ?paymentMethod=MERCADO_PAGO funciona', filtered.json.every(p => p.paymentMethod === 'MERCADO_PAGO'));

  const events = await get('/api/events');
  ok('hay eventos publicados', events.json.length > 0);

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log(`\n== Resultado: ${passed} pasaron, ${failed} fallaron ==\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('\n💥 Error ejecutando los tests — ¿está el servidor corriendo? (npm start)\n');
  console.error(err.message);
  process.exit(1);
});
