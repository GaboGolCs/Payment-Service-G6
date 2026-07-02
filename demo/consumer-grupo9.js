/**
 * SIMULA A GRUPO 9 (Notificaciones)
 *
 * En la arquitectura real, este código vive en el repo del Grupo 9.
 * Aquí lo replicamos mínimamente para poder DEMOSTRAR, sin depender de
 * otro equipo, que los eventos de Grupo 6 llegan por webhook HTTP (ya no
 * por RabbitMQ: el servicio de pagos corre solo sobre Supabase).
 *
 * Levanta un endpoint propio que recibe un POST con el PaymentEvent cada
 * vez que ocurre payment.pending / payment.approved / payment.rejected
 * (Grupo 9 quiere enterarse de todo el ciclo de vida para notificar al
 * usuario).
 *
 * Uso:
 *   1. node demo/consumer-grupo9.js   (levanta el receptor en :4001)
 *   2. En el .env de Grupo 6, agregar:
 *        WEBHOOK_URLS_PAYMENT_PENDING="http://localhost:4001/webhooks/payments"
 *        WEBHOOK_URLS_PAYMENT_APPROVED="http://localhost:4001/webhooks/payments"
 *        WEBHOOK_URLS_PAYMENT_REJECTED="http://localhost:4001/webhooks/payments"
 *   3. Disparar cualquier flujo de pago (crear/confirmar/rechazar) y ver
 *      los eventos llegar acá.
 */
require('dotenv/config');
const express = require('express');

const PORT = process.env.GRUPO9_PORT || 4001;
const app = express();
app.use(express.json());

app.post('/webhooks/payments', (req, res) => {
  const event = req.body;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📩 [Grupo 9] Evento recibido: ${event.eventName}`);
  console.log(`   paymentId: ${event.paymentId}`);
  console.log(`   payload:`, event.payload);
  console.log(`   → Acción simulada: enviar notificación (push/email) al usuario del pedido ${event.payload?.orderId}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  res.status(200).json({ received: true });
});

app.listen(PORT, () => {
  console.log(`[Grupo 9 - Notificaciones] Escuchando webhooks en http://localhost:${PORT}/webhooks/payments`);
  console.log('[Grupo 9 - Notificaciones] Esperando eventos... (Ctrl+C para salir)\n');
});
