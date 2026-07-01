# Payment Service — Mock Server

Mock Express que simula todos los endpoints del payment-service real sin necesitar PostgreSQL ni RabbitMQ.

Soporta dos métodos de pago:

- **SIMULATED** → flujo original (sin cambios): el estado se controla manualmente vía `/confirm` y `/reject`.
- **MERCADO_PAGO** → simula el flujo real de **Checkout Pro** de Mercado Pago (preferencia → checkout → webhook). No se llama a la API real de MP en ningún momento; todo es mock en memoria.

## Arrancar

```bash
npm install
npm start
# → http://localhost:3000
```

## Desplegado en Render

Este mock está publicado en:

**`https://payment-service-g6.onrender.com`**

Todos los ejemplos de este README usan `localhost:3000`; para probar contra Render, reemplaza esa parte por la URL de arriba, por ejemplo:

```bash
curl -X POST https://payment-service-g6.onrender.com/api/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid>" \
  -d '{"amount": 15990, "currency": "CLP", "orderId": "ORD-1001"}'
```

También puedes correr el smoke test contra Render en vez de local:

```bash
BASE_URL=https://payment-service-g6.onrender.com node test-flow.js
```

**Cosas a tener en cuenta usando la versión de Render:**

- **Cold start (plan Free):** si el servicio está en el plan gratuito de Render, se "duerme" tras ~15 min sin tráfico. La primera request después de eso puede demorar 30-50 segundos en responder mientras el contenedor despierta — no significa que esté caído. Si están en un plan pago, no aplica.
- **Persistencia en memoria:** los datos (`payments`, `mpPreferences`, `mpPayments`, `events`) viven solo en memoria del proceso. Cada vez que Render redeploya (por un push a la rama conectada) o el servicio se duerme/despierta, el proceso se reinicia y **se pierden todos los pagos creados**. Para una demo, crea los pagos de prueba justo antes de mostrarlos.
- **CORS:** el mock ya responde con `Access-Control-Allow-Origin: *`, así que puede ser consumido sin problema desde el frontend u otros servicios en dominios distintos (necesario en Render, donde cada servicio vive en su propia URL).
- **`initPoint` de Mercado Pago:** sigue siendo una URL simulada (`https://sandbox.mercadopago.mock/...`) — no es un checkout real ni redirige a ningún lado, es solo el valor que devolvería la preferencia en el flujo real.

## Endpoints — Payments

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/payments` | Crear pago (requiere `Idempotency-Key`). Body admite `paymentMethod: "SIMULATED" \| "MERCADO_PAGO"` (default `SIMULATED`) |
| GET | `/api/payments` | Listar pagos (`?status=` / `?orderId=` / `?paymentMethod=`) |
| GET | `/api/payments/stats` | Estadísticas por estado y por método de pago |
| GET | `/api/payments/:id` | Consultar pago individual |
| GET | `/api/payments/:id/mercadopago` | Sub-objeto de Mercado Pago de un pago (`preferenceId`, `initPoint`, `mpPaymentId`, `mpStatus`) |
| POST | `/api/payments/:id/confirm` | PENDING → APPROVED — **solo pagos SIMULATED** |
| POST | `/api/payments/:id/reject` | PENDING → REJECTED — **solo pagos SIMULATED** |

## Endpoints — Mercado Pago (mock)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/mercadopago/simulate-payment` | Simula que el comprador terminó el checkout en MP. Crea un "pago MP" con el resultado indicado y dispara el webhook automáticamente. |
| POST | `/api/payments/mercadopago/webhook` | Endpoint que Mercado Pago llamaría en producción (IPN). Puede invocarse manualmente para pruebas. |

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/events` | Log en memoria de eventos "publicados" (`PaymentPending`/`PaymentApproved`/`PaymentRejected`) — no hay RabbitMQ real, solo para debug/demo |

## Flujo Mercado Pago

1. **Crear el pago** indicando `paymentMethod: "MERCADO_PAGO"`:

   ```bash
   curl -X POST localhost:3000/api/payments \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: <uuid>" \
     -d '{"amount": 15990, "currency": "CLP", "orderId": "ORD-1001", "paymentMethod": "MERCADO_PAGO"}'
   ```

   La respuesta incluye `mercadoPago.initPoint`: la URL (mock) de checkout a la que redirigirías al comprador.

2. **Simular que el comprador pagó en MP**:

   ```bash
   curl -X POST localhost:3000/api/mercadopago/simulate-payment \
     -H "Content-Type: application/json" \
     -d '{"preferenceId": "<preferenceId>", "result": "approved"}'
   ```

   `result` acepta: `approved`, `rejected`, `pending`, `in_process`, `cancelled` (estados reales de MP).
   Este paso crea el "pago MP" y dispara automáticamente el webhook, igual que lo haría Mercado Pago en producción.

3. **El webhook actualiza el Payment** (PENDING → APPROVED/REJECTED según el resultado) y publica el evento correspondiente. `pending`/`in_process` no disparan transición: solo actualizan `mercadoPago.mpStatus`.

4. Los pagos `MERCADO_PAGO` **no admiten** `/confirm` ni `/reject` manuales — el estado solo cambia vía webhook, igual que en el sistema real.

### Llamar el webhook directamente (sin pasar por `simulate-payment`)

```bash
curl -X POST localhost:3000/api/payments/mercadopago/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "payment", "data": {"id": "<mpPaymentId>"}}'
```

Requiere que `<mpPaymentId>` ya exista (generado por `/simulate-payment`). El webhook es idempotente: si el pago ya está en estado final, reintentos no lo reprocesan y siempre responde `200`.

## Idempotencia

Incluir el header `Idempotency-Key: <uuid>` en POST. Si se repite la misma key, retorna el resultado cacheado (HTTP 200) sin re-procesar. Aplica igual para ambos métodos de pago.

## Estado persistido

Solo en memoria. Reiniciar el servidor limpia todos los pagos, preferencias, pagos MP y eventos.
