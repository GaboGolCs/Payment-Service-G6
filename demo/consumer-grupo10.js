/**
 * SIMULA A GRUPO 10 (Reportería)
 *
 * Igual que el consumer de Grupo 9, esto normalmente vive en el repo de
 * Grupo 10. Lo replicamos aquí solo para poder demostrar el flujo completo.
 *
 * Grupo 10 usa AMBOS canales que muestra el diagrama:
 *  1. Webhook HTTP: recibe payment.approved / payment.rejected para
 *     actualizar sus métricas en tiempo real (eventual consistency).
 *  2. HTTP polling: cada cierto tiempo llama GET /api/payments/stats para
 *     reconciliar/auditar contra el estado real de la fuente de verdad.
 *
 * Uso:
 *   1. node demo/consumer-grupo10.js  (levanta el receptor en :4002)
 *   2. En el .env de Grupo 6, agregar:
 *        WEBHOOK_URLS_PAYMENT_APPROVED="http://localhost:4002/webhooks/payments"
 *        WEBHOOK_URLS_PAYMENT_REJECTED="http://localhost:4002/webhooks/payments"
 */
require('dotenv/config');
const express = require('express');

const PORT = process.env.GRUPO10_PORT || 4002;
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3000';
const STATS_POLL_INTERVAL_MS = 10_000;

const app = express();
app.use(express.json());

async function pollStats() {
  try {
    const res = await fetch(`${PAYMENT_SERVICE_URL}/api/payments/stats`);
    const stats = await res.json();
    console.log(`\n📊 [Grupo 10] GET /api/payments/stats →`, JSON.stringify(stats));
  } catch (err) {
    console.error('[Grupo 10] No se pudo consultar /stats:', err.message);
  }
}

app.post('/webhooks/payments', (req, res) => {
  const event = req.body;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📈 [Grupo 10] Evento recibido: ${event.eventName}`);
  console.log(`   paymentId: ${event.paymentId} | monto: ${event.payload?.amount} ${event.payload?.currency}`);
  console.log(`   → Acción simulada: actualizar dashboard de reportería`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  res.status(200).json({ received: true });
  pollStats(); // reconciliar contra la fuente de verdad justo después del evento
});

app.listen(PORT, () => {
  console.log(`[Grupo 10 - Reportería] Escuchando webhooks en http://localhost:${PORT}/webhooks/payments`);
  console.log(`[Grupo 10 - Reportería] Además, consultará ${PAYMENT_SERVICE_URL}/api/payments/stats cada ${STATS_POLL_INTERVAL_MS / 1000}s`);
  console.log('[Grupo 10 - Reportería] Esperando eventos... (Ctrl+C para salir)\n');
  pollStats();
  setInterval(pollStats, STATS_POLL_INTERVAL_MS);
});
