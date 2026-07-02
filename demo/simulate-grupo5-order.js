/**
 * SIMULA A GRUPO 5 (Pedidos)
 *
 * Representa lo que hace el servicio de Pedidos cuando un usuario confirma
 * un carrito: llama POST /api/payments para generar el pago + init_point,
 * y luego consulta GET /api/payments/:id para hacer seguimiento del estado
 * (por ejemplo, antes de que llegue el evento de RabbitMQ, o como fallback).
 *
 * Uso:
 *   node demo/simulate-grupo5-order.js
 *   node demo/simulate-grupo5-order.js --amount 5990 --order "order-demo-42"
 */
require('dotenv/config');

const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3000';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const orderId = arg('order', `order-demo-${Date.now()}`);
  const amount = Number(arg('amount', '9990'));

  console.log(`[Grupo 5 - Pedidos] Simulando confirmación del pedido "${orderId}" por $${amount}...`);
  console.log(`[Grupo 5 - Pedidos] POST ${PAYMENT_SERVICE_URL}/api/payments\n`);

  const res = await fetch(`${PAYMENT_SERVICE_URL}/api/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `${orderId}-checkout`,
    },
    body: JSON.stringify({
      amount,
      currency: 'CLP',
      orderId,
      description: `Pedido ${orderId} — Vigía Industrial`,
      payerEmail: 'test_user_comprador@testuser.com',
    }),
  });

  if (!res.ok) {
    console.error(`[Grupo 5 - Pedidos] Error ${res.status}:`, await res.text());
    process.exit(1);
  }

  const payment = await res.json();
  console.log('[Grupo 5 - Pedidos] Respuesta de Grupo 6:');
  console.log(JSON.stringify(payment, null, 2));

  if (payment.initPoint) {
    console.log('\n✅ init_point recibido. Grupo 1 (Web/Móvil) redirigiría al usuario aquí:');
    console.log(`   ${payment.initPoint}`);
    console.log('\n   Ábrelo en el navegador y paga con una tarjeta de prueba de Mercado Pago');
    console.log('   (ver README > "Cómo obtener credenciales de prueba").');
  } else {
    console.log('\n⚠️  No se generó init_point (¿configuraste MP_ACCESS_TOKEN en .env?).');
    console.log('   El pago igual quedó creado en PENDING; puedes simular su aprobación con:');
    console.log(`   curl -X POST ${PAYMENT_SERVICE_URL}/api/payments/${payment.id}/confirm -H "Idempotency-Key: demo-confirm-1"`);
  }

  console.log(`\n[Grupo 5 - Pedidos] Guarda este id para seguimiento: ${payment.id}`);
  console.log(`[Grupo 5 - Pedidos] Puedes consultarlo con: GET ${PAYMENT_SERVICE_URL}/api/payments/${payment.id}`);
}

main().catch((err) => {
  console.error('[Grupo 5 - Pedidos] Error inesperado:', err);
  process.exit(1);
});
