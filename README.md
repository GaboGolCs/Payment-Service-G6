# Payment Service — Mini Marketplace Grupo 6

Microservicio de pagos para el proyecto **Mini Marketplace** (Arquitectura de Software). Gestiona el ciclo de vida de pagos con idempotencia, máquina de estados transaccional y publicación de eventos vía RabbitMQ.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| ORM | Prisma |
| Base de datos | PostgreSQL |
| Caché / Idempotencia | Redis |
| Mensajería | RabbitMQ |
| Validación | Zod |
| Testing | Jest |

---

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/payments` | Crear pago (estado inicial: PENDING) |
| `GET` | `/api/payments` | Listar pagos (`?status=` / `?orderId=`) |
| `GET` | `/api/payments/stats` | Estadísticas por estado |
| `GET` | `/api/payments/:id` | Consultar pago individual |
| `POST` | `/api/payments/:id/confirm` | Transición PENDING → APPROVED |
| `POST` | `/api/payments/:id/reject` | Transición PENDING → REJECTED |

---

## Máquina de estados

```
PENDING ──confirm──▶ APPROVED
       ──reject───▶ REJECTED
```

Cualquier intento de transición desde un estado final devuelve `409 INVALID_STATE_TRANSITION`.

---

## Patrones implementados

- **Idempotencia**: header `Idempotency-Key` requerido en POST. Resultado cacheado en Redis; llamadas repetidas devuelven el mismo resultado sin re-procesar.
- **Optimistic locking**: `UPDATE WHERE version = N` previene doble procesamiento en race conditions.
- **Eventos (eventual consistency)**: publica a RabbitMQ tras cada transición exitosa.

| Evento | Cuándo | Consumidores |
|--------|--------|--------------|
| `PaymentPending` | Al crear | Grupo 9 (notificaciones) |
| `PaymentApproved` | Al confirmar | Grupos 5 (pedidos), 10 (reportería) |
| `PaymentRejected` | Al rechazar | Grupos 9, 10 |

---

## Instalación y arranque

### Requisitos

- Node.js 20+
- Docker (para PostgreSQL + Redis + RabbitMQ)

### Pasos

```bash
# 1. Clonar e instalar dependencias
git clone <url-repo>
cd payment-service
npm install

# 2. Copiar variables de entorno
cp .env.example .env

# 3. Levantar infraestructura
npm run docker:up

# 4. Ejecutar migraciones
npm run prisma:migrate

# 5. Arrancar en desarrollo
npm run dev
```

El servicio queda disponible en `http://localhost:3000`.

---

## Variables de entorno

```env
DATABASE_URL=postgresql://user:password@localhost:5432/payments
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://localhost:5672
PORT=3000
```

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

Disponible en `/mock-payment`. Simula todos los endpoints sin necesitar PostgreSQL, Redis ni RabbitMQ.

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
