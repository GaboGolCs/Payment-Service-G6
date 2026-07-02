# Payment Service — Mini Marketplace Grupo 6

Microservicio de pagos para el proyecto **Mini Marketplace** (Arquitectura de Software). Gestiona el ciclo de vida de pagos con idempotencia, máquina de estados transaccional y publicación de eventos vía webhooks HTTP. Toda la infraestructura corre sobre **Supabase** (Postgres) — sin Redis ni RabbitMQ.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| ORM | Prisma |
| Base de datos | PostgreSQL (Supabase) |
| Caché / Idempotencia | Postgres (`IdempotencyRecord`, vía Prisma) |
| Eventos | Webhooks HTTP (fan-out con reintento) |
| Validación | Zod |
| Testing | Jest |

---

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/payments` | Crear pago (PENDING) + preferencia Checkout Pro en Mercado Pago → devuelve `init_point` |
| `GET` | `/api/payments` | Listar pagos (`?status=` / `?orderId=`) — **consumido por Grupo 5** |
| `GET` | `/api/payments/stats` | Estadísticas por estado — **consumido por Grupo 10 (reportería)** |
| `GET` | `/api/payments/:id` | Consultar pago individual |
| `POST` | `/api/payments/:id/confirm` | Transición manual PENDING → APPROVED (uso interno/testing) |
| `POST` | `/api/payments/:id/reject` | Transición manual PENDING → REJECTED (uso interno/testing) |
| `POST` | `/api/payments/webhook` | **Webhook público de Mercado Pago** — notifica cambios de estado del pago real |
| `GET` | `/health` | Health check (usado por Render y por otros grupos para verificar disponibilidad) |

---

## Integración con Mercado Pago (Checkout Pro)

Flujo alineado al diagrama de arquitectura del proyecto:

```
Grupo 5 (Pedidos) ──POST /api/payments──▶ Grupo 6 (este servicio)
                                                │
                                                ├─▶ POST Crea Preferencia (Checkout Pro) ──▶ Mercado Pago API
                                                │◀─ preferenceId + init_point ─────────────┘
                                                │
Grupo 5 ◀──── init_point ───────────────────────┘
   │
   └──▶ Grupo 1 (Web/Móvil) redirige al usuario a init_point (pasarela de Mercado Pago)

Mercado Pago API ──POST Webhook (estado del pago)──▶ POST /api/payments/webhook
                                                          │
                                                          ├─▶ GET /v1/payments/:id en Mercado Pago
                                                          │   (nunca se confía en el body del webhook)
                                                          ├─▶ Actualiza estado (optimistic locking)
                                                          └─▶ Publica evento vía webhook HTTP (POST a cada suscriptor)
```

**Puntos clave de la implementación** (`src/services/mercadopago.service.ts`):

- `createPreference`: crea la preferencia con `external_reference = Payment.id` (así el webhook puede reconciliar sin ambigüedad), `notification_url` apuntando a `${BASE_URL}/api/payments/webhook`, y `back_urls` de éxito/fallo/pendiente.
- El webhook **nunca confía en el body de la notificación**: Mercado Pago solo garantiza `{ type, data: { id } }`; siempre se vuelve a consultar `GET /v1/payments/:id` contra la API real antes de aplicar la transición.
- **Verificación de firma** (`x-signature` / `x-request-id`) con HMAC-SHA256 sobre el manifest oficial, usando `MP_WEBHOOK_SECRET`.
- **Idempotencia del webhook**: si el pago ya está en estado final (no PENDING), la notificación se reconoce con `200` pero no se reprocesa ni se vuelve a publicar el evento — necesario porque Mercado Pago reintenta notificaciones agresivamente.
- Reutiliza el mismo optimistic locking (`version` + `status`) que ya usaban `confirm`/`reject`, así que una doble notificación casi simultánea no puede duplicar el evento.

### Cómo obtener credenciales de prueba

1. Crear/loguearse en tu cuenta de [Mercado Pago Developers](https://www.mercadopago.com/developers).
2. **Tus integraciones → Crear aplicación** → elegir "Pagos online" → Checkout Pro.
3. En **Credenciales de prueba** copiar `Access Token` y `Public Key` → van en `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY`.
4. En **Webhooks** configurar la URL `https://<tu-servicio>.onrender.com/api/payments/webhook` y copiar la **Firma secreta** → `MP_WEBHOOK_SECRET`.
5. Para probar pagos reales sin dinero real, usar los [usuarios y tarjetas de prueba](https://www.mercadopago.com/developers/es/docs/checkout-pro/additional-content/your-integrations/test/accounts) de Mercado Pago (compradores/vendedores de test, tarjeta `APRO` para aprobar, `OTHE` para rechazar, etc).
6. Si trabajas en `localhost`, Mercado Pago no puede llegar a tu máquina: expón el puerto con `ngrok http 3000` y usa esa URL como `BASE_URL`/webhook mientras pruebas.

> Si `MP_ACCESS_TOKEN` no está configurado, el servicio sigue funcionando en modo degradado: crea el `Payment` en PENDING pero no genera `init_point` (útil para desarrollo/tests sin credenciales).

---

## Máquina de estados

```
PENDING ──confirm──▶ APPROVED
       ──reject───▶ REJECTED
```

Cualquier intento de transición desde un estado final devuelve `409 INVALID_STATE_TRANSITION`.

---

## Patrones implementados

- **Idempotencia**: header `Idempotency-Key` requerido en POST. Resultado cacheado en Postgres (`IdempotencyRecord`, TTL 24h); llamadas repetidas devuelven el mismo resultado sin re-procesar.
- **Optimistic locking**: `UPDATE WHERE version = N` previene doble procesamiento en race conditions.
- **Eventos (eventual consistency)**: dispara un `POST` HTTP a cada suscriptor tras cada transición exitosa (fan-out en paralelo, con 1 reintento por URL; un suscriptor caído no bloquea la respuesta al cliente).

| Evento | Cuándo | Variable de entorno (URLs, separadas por coma) | Consumidores |
|--------|--------|--------------------------------------------------|--------------|
| `PaymentPending` | Al crear el pago | `WEBHOOK_URLS_PAYMENT_PENDING` | Grupo 9 (notificaciones) |
| `PaymentApproved` | Al aprobar (webhook MP o `/confirm`) | `WEBHOOK_URLS_PAYMENT_APPROVED` | Grupo 5 (pedidos), Grupo 9, Grupo 10 (reportería) |
| `PaymentRejected` | Al rechazar (webhook MP o `/reject`) | `WEBHOOK_URLS_PAYMENT_REJECTED` | Grupo 9, Grupo 10 |

Cada grupo consumidor expone su propio endpoint HTTP (p. ej. `POST /webhooks/payments`) y nos pasa su URL para agregarla a la variable correspondiente. El body que reciben es idéntico al `PaymentEvent` que antes viajaba por RabbitMQ — solo cambió el transporte (HTTP en vez de AMQP), así que el contrato de datos no cambia para los otros grupos.

---

## Conexiones con otros grupos (según diagrama de arquitectura)

| Grupo | Vía | Detalle |
|-------|-----|---------|
| **Grupo 1** (Web/Móvil) | Indirecta, a través de Grupo 5 | Recibe el `init_point` y redirige al usuario a la pasarela de Mercado Pago |
| **Grupo 5** (Pedidos) | HTTP síncrono | `POST /api/payments` (crea pago + retorna `init_point`) y `GET /api/payments` |
| **Grupo 9** (Notificaciones) | Webhook HTTP (asíncrono) | Recibe `POST` en su propio endpoint para `PaymentPending`, `PaymentApproved`, `PaymentRejected` |
| **Grupo 10** (Reportería) | Webhook HTTP + polling HTTP | Recibe `POST` para `PaymentApproved`/`PaymentRejected` **y** consulta `GET /api/payments/stats` bajo demanda |
| **Mercado Pago** | HTTP saliente + Webhook entrante | `POST` crea preferencia (Checkout Pro); Mercado Pago llama de vuelta a `POST /api/payments/webhook` |

## Demo local end-to-end (Grupo 5 → Grupo 6 → Mercado Pago → Grupo 9/10)

Ver [`DEMO.md`](./DEMO.md): guía paso a paso con scripts (`demo/`) que
simulan a Grupo 5 creando un pago y a Grupo 9/Grupo 10 recibiendo los
eventos por webhook HTTP, más cómo capturar evidencia para la pauta
(logs, requests entrantes, consultas a la base de datos).

---

### Requisitos

- Node.js 20+
- Un proyecto de [Supabase](https://supabase.com) (gratis) — o, alternativamente, Docker para levantar un Postgres local de desarrollo.

### Pasos

```bash
# 1. Clonar e instalar dependencias
git clone https://github.com/GaboGolCs/Payment-Service-G6.git
cd Payment-Service-G6
npm install

# 2. Copiar variables de entorno
cp .env.example .env
# → pegar el Session pooler connection string de tu proyecto Supabase en DATABASE_URL

# 3a. (Opción recomendada) usar Supabase directo: no requiere Docker.
# 3b. (Alternativa local) levantar solo Postgres en Docker:
#     npm run docker:up   # y usar DATABASE_URL=postgresql://user:password@localhost:5432/payments_db

# 4. Ejecutar migraciones
npm run prisma:migrate

# 5. Arrancar en desarrollo
npm run dev
```

El servicio queda disponible en `http://localhost:3000`.

---

## Variables de entorno

Ver `.env.example` para la lista completa y comentada. Resumen:

| Variable | Obligatoria | Descripción |
|----------|:-----------:|-------------|
| `DATABASE_URL` | Sí | Connection string de Supabase (Session pooler, puerto 5432) |
| `PORT` | No (default 3000) | Puerto HTTP |
| `BASE_URL` | Sí en producción | URL pública del servicio, usada para armar la `notification_url` del webhook |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | Sí para integrar MP | Credenciales de Mercado Pago (sandbox o producción) |
| `MP_WEBHOOK_SECRET` | Recomendada | Verifica la firma `x-signature` del webhook |
| `FRONTEND_SUCCESS_URL` / `_FAILURE_URL` / `_PENDING_URL` | No | Redirección post-pago (Grupo 1) |
| `WEBHOOK_URLS_PAYMENT_PENDING` / `_APPROVED` / `_REJECTED` | No | URLs (separadas por coma) de los grupos que reciben cada evento vía HTTP |

Ninguna credencial va commiteada: `.env` está en `.gitignore`, `.env.example` solo trae placeholders.

---

## Despliegue en cloud (Supabase + Render, free tier)

Este servicio corre con **solo dos piezas de infraestructura**: la app (Node, en Render) y la base de datos (Postgres, en Supabase). No hay Redis ni RabbitMQ que administrar — la idempotencia vive en Postgres y los eventos se entregan por webhook HTTP directo a cada grupo consumidor.

### Pasos

1. **Crear el proyecto en Supabase**: supabase.com → New Project.
2. **Obtener el connection string**: Project Settings → Database → Connect → copiar el **Session pooler** (puerto `5432`, no el Transaction pooler de `6543` — `prisma migrate deploy` necesita el modo sesión para sus advisory locks). Ese string va en `DATABASE_URL`.
3. **Crear la app en Render**: New → Web Service → conectar el repo de GitHub → Render detecta el `Dockerfile` automáticamente (Runtime: Docker).
4. **Configurar env vars** del Web Service: `DATABASE_URL` (el de Supabase), `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY`, `MP_WEBHOOK_SECRET`, `BASE_URL` (la URL pública que Render asigna, ej. `https://payment-service-g6.onrender.com` — se conoce recién después del primer deploy, así que se completa y se redeploya), las `FRONTEND_*_URL`, y las `WEBHOOK_URLS_*` con las URLs que te pasen los Grupos 5/9/10.
5. **Health check path**: `/health`.
6. Deploy. El `Dockerfile` ya corre `prisma migrate deploy` antes de levantar el servidor, así que las migraciones se aplican automáticamente contra Supabase en cada deploy.
7. Configurar en el panel de Mercado Pago la URL del webhook: `https://<tu-app>.onrender.com/api/payments/webhook`.
8. Verificar: `GET https://<tu-app>.onrender.com/health` debe responder `{"status":"ok", ...}`.

> Notas: en el free tier, Render "duerme" el servicio tras inactividad (cold start ~30-50s en el primer request); el proyecto free de Supabase se pausa tras ~1 semana sin actividad (se reactiva solo con el primer request, pero puede tardar unos segundos). Ninguna de las dos cosas indica una falla.

---

## CI/CD

`.github/workflows/ci.yml` corre en cada push/PR a `main`:

1. Levanta Postgres como servicio efímero de GitHub Actions.
2. `npm ci` → `prisma generate` → `prisma migrate deploy` (valida que las migraciones sean aplicables).
3. `npm run build` (type-check + compilación TypeScript).
4. `npm test` (suite de Jest).
5. `docker build` de la imagen final, para detectar errores del `Dockerfile` antes de deployar.

El deploy a Render se dispara automáticamente al hacer push a `main` (auto-deploy nativo de Render conectado al repo de GitHub) — no requiere un paso adicional en el workflow. Si se prefiere disparo explícito, puede agregarse un `deploy hook` de Render invocado vía `curl` como último step del job (usando un secret `RENDER_DEPLOY_HOOK_URL`).

---

## Testing

```bash
# Ejecutar todos los tests
npm test

# Modo watch
npm run test:watch
```

---

## Mock (para desarrollo sin infraestructura)

Disponible en `/mock-payment`. Simula todos los endpoints sin necesitar Supabase ni infraestructura adicional.

```bash
cd mock-payment
npm install
npm start
# → http://localhost:3000
```

---

## Colección de pruebas

Colección Bruno en `/bruno-collection/payment-service` con 12 requests que cubren flujo feliz, idempotencia, transiciones inválidas y validación de inputs.

Para usarla: abrir Bruno → **Open Collection** → seleccionar la carpeta `payment-service`.
