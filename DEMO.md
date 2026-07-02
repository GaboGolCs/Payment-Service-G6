# Demo local end-to-end — evidencia para la pauta

Este documento te guía para demostrar, con tu propia máquina, el flujo
completo: **Grupo 5 crea un pago → Mercado Pago procesa el cobro → el
webhook de Mercado Pago llega → el servicio publica el evento vía webhook
HTTP → Grupo 9 y Grupo 10 lo reciben** (simulados aquí, porque sus repos
son de otros equipos).

La infraestructura es **solo Supabase** (Postgres) — no hay Redis, RabbitMQ
ni contenedores de mensajería que levantar.

Necesitas **5 terminales** abiertas en la carpeta del proyecto. Ábrelas
una por una en el orden indicado.

---

## 0. Preparación (una sola vez)

```bash
npm install
cp .env.example .env
```

Edita `.env` y completa:

1. `DATABASE_URL`: el **Session pooler** connection string de tu proyecto
   Supabase (Project Settings → Database → Connect, puerto `5432`).
2. `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY`: tus credenciales de **PRUEBA** de
   Mercado Pago (ver README, sección "Cómo obtener credenciales de prueba").
3. Las URLs de los receptores simulados de Grupo 9 y Grupo 10 (los levantas
   más abajo en los Terminales C y D):

   ```
   WEBHOOK_URLS_PAYMENT_PENDING="http://localhost:4001/webhooks/payments"
   WEBHOOK_URLS_PAYMENT_APPROVED="http://localhost:4001/webhooks/payments,http://localhost:4002/webhooks/payments"
   WEBHOOK_URLS_PAYMENT_REJECTED="http://localhost:4001/webhooks/payments,http://localhost:4002/webhooks/payments"
   ```

---

## Terminal A — Base de datos

```bash
npm run prisma:migrate     # aplica las migraciones contra Supabase (crea las tablas)
```

📸 **Evidencia sugerida**: captura de la salida de `prisma migrate` mostrando las migraciones aplicadas, o de las tablas en el **Table Editor** de Supabase.

> Si prefieres no depender de internet para la demo, puedes usar
> `npm run docker:up` para levantar un Postgres local y apuntar
> `DATABASE_URL` a `postgresql://user:password@localhost:5432/payments_db`
> en vez de Supabase — el resto de la guía es idéntico.

---

## Terminal B — Simula a Grupo 9 (Notificaciones)

```bash
npm run demo:grupo9
```

Levanta un receptor HTTP en `:4001` y queda escuchando en silencio. Esta
terminal va a "despertar" más adelante cuando llegue un evento — no la
cierres.

## Terminal C — Simula a Grupo 10 (Reportería)

```bash
npm run demo:grupo10
```

Levanta un receptor HTTP en `:4002` y ya empieza a imprimir el resultado de
`GET /stats` cada 10 segundos (así demuestras también el canal de polling,
no solo el webhook).

---

## Terminal D — El servicio de pagos (Grupo 6, este repo)

```bash
npm run dev
```

Deberías ver:
```
[EventPublisher] Listo (modo HTTP webhooks, sin broker externo)
[Payment Service] Running on http://localhost:3000
[Payment Service] Health: http://localhost:3000/health
```

Verifica: `curl http://localhost:3000/health` → `{"status":"ok",...}`.

📸 **Evidencia sugerida**: captura de estos logs de arranque.

---

## Terminal E — Simula a Grupo 5 (Pedidos) creando la orden

```bash
npm run demo:grupo5 -- --amount 9990 --order "order-demo-1"
```

Esto hace exactamente lo que hará el servicio real de Grupo 5: llama
`POST /api/payments`. La consola te va a imprimir un `init_point`:

```
✅ init_point recibido. Grupo 1 (Web/Móvil) redirigiría al usuario aquí:
   https://sandbox.mercadopago.com/checkout/v1/redirect?pref_id=...
```

En la Terminal B (Grupo 9) deberías ver de inmediato `📩 Evento recibido:
PaymentPending` — el primer webhook ya viajó.

📸 **Evidencia sugerida**: captura del JSON de respuesta (incluye el `id`
del pago, `status: "PENDING"`, `initPoint`) y del log en Terminal B.

---

## Paso siguiente: completar el pago

Tienes **dos caminos**. El primero es más real; el segundo no requiere
exponer tu máquina a internet.

### Opción 1 (recomendada) — Pago real en sandbox + webhook real

Mercado Pago necesita poder llamarte de vuelta, así que tu `localhost`
debe ser accesible desde internet:

```bash
# En una terminal aparte
ngrok http 3000
```

Copia la URL que te da ngrok (`https://xxxx.ngrok-free.app`) y:

1. Detén el Terminal D (Ctrl+C).
2. En `.env`, pon `BASE_URL="https://xxxx.ngrok-free.app"`.
3. Vuelve a correr `npm run dev` (el `notification_url` se arma con
   `BASE_URL` en cada pago nuevo, así que **crea un pago nuevo** después
   de este cambio — el `order-demo-1` anterior quedó con la URL vieja).
4. Repite el Terminal E (`npm run demo:grupo5`) para generar un `init_point`
   nuevo, esta vez con el `notification_url` apuntando a ngrok.
5. Abre el `init_point` en el navegador y paga con una [tarjeta de
   prueba](https://www.mercadopago.com/developers/es/docs/checkout-pro/additional-content/your-integrations/test/cards)
   (por ejemplo, Mastercard `5031 7557 3453 0604`, cualquier fecha futura,
   CVV `123`, y usa el nombre `APRO` como titular para forzar aprobación).
6. Mercado Pago te redirige a `FRONTEND_SUCCESS_URL` y, en paralelo, llama
   a tu webhook.

📸 **Evidencia sugerida**:
- Terminal D: log `[webhook]`/`POST /api/payments/webhook 200`.
- Terminal B (Grupo 9): imprime `📩 Evento recibido: PaymentApproved`.
- Terminal C (Grupo 10): imprime `📈 Evento recibido: PaymentApproved` y el
  siguiente poll de `/stats` con el conteo actualizado.
- Panel de ngrok (`http://127.0.0.1:4040`) mostrando el request entrante
  al webhook con status 200.

### Opción 2 (sin ngrok) — Simular la aprobación manualmente

Si solo quieres demostrar el flujo de eventos sin depender de Mercado Pago
real:

```bash
curl -X POST http://localhost:3000/api/payments/<paymentId>/confirm \
  -H "Idempotency-Key: demo-confirm-1"
```

(reemplaza `<paymentId>` por el `id` que te dio el Terminal E). Esto
dispara el mismo evento `PaymentApproved` por el mismo camino (webhook
HTTP a Grupo 9/10), solo que la transición la gatillas tú en vez de
Mercado Pago.

📸 **Evidencia sugerida**: igual que la Opción 1.

---

## Evidencia adicional para la pauta

### Base de datos (persistencia)

Si usas Supabase, abre el **Table Editor** de tu proyecto y filtra la
tabla `Payment`. Si usas Postgres local vía Docker:

```bash
docker compose exec postgres psql -U user -d payments_db \
  -c "SELECT id, status, \"orderId\", amount, \"mpPaymentId\", \"initPoint\" FROM \"Payment\";"
```

📸 Captura de la tabla con el pago en estado `APPROVED` y su `mpPaymentId` poblado.

### Idempotencia (tabla IdempotencyRecord)

```bash
docker compose exec postgres psql -U user -d payments_db \
  -c "SELECT key, \"paymentId\", \"createdAt\" FROM \"IdempotencyRecord\";"
```

(o la consulta equivalente en el Table Editor de Supabase). Muestra que el
`Idempotency-Key` usado en el `/confirm` de la Opción 2 quedó cacheado.

### Eventos (webhooks)

Las capturas de las Terminales B y C mostrando `📩`/`📈 Evento recibido`
son la evidencia del fan-out de eventos — equivalen a lo que antes se
mostraba en la UI de RabbitMQ, pero ahora es un log HTTP directo de cada
suscriptor.

### Casos de error (manejo de errores)

```bash
# 400 — validación
curl -X POST http://localhost:3000/api/payments \
  -H "Content-Type: application/json" -d '{"amount": -10}'

# 404 — pago inexistente
curl http://localhost:3000/api/payments/no-existe

# 409 — doble confirmación de un pago ya aprobado
curl -X POST http://localhost:3000/api/payments/<paymentId>/confirm
```

También puedes correr toda la colección de Bruno (`/bruno-collection`),
que ya cubre estos 3 casos más idempotencia.

### Tests automatizados

```bash
npm test
```

📸 Captura de la salida con los tests en verde (incluye el caso de race
condition y el de idempotencia del webhook).

---

## Resumen de lo que queda demostrado

| Ítem de la pauta | Cómo se demuestra |
|---|---|
| Endpoints principales | Terminal E (`POST /payments`) + `payments.http`/Bruno |
| Persistencia | Query a Supabase/Postgres con el pago y sus campos de Mercado Pago |
| Manejo de errores | Casos 400/404/409 de arriba |
| Conexión con Grupo 5 | Terminal E simulando la llamada real que hará ese equipo |
| Conexión con Grupo 9 | Terminal B recibiendo el evento por webhook HTTP |
| Conexión con Grupo 10 | Terminal C recibiendo el evento + polling de `/stats` |
| Integración Mercado Pago | `init_point` real + webhook real (Opción 1) |
| Pruebas funcionales | `npm test` + colección Bruno |
