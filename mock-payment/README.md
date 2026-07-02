# Payment Service — Mock Server

Mock Express que simula todos los endpoints del payment-service real sin necesitar PostgreSQL ni RabbitMQ.

## Arrancar

```bash
npm install
npm start
# → http://localhost:3000
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/payments` | Crear pago (requiere `Idempotency-Key`) |
| GET | `/api/payments` | Listar pagos (`?status=` / `?orderId=`) |
| GET | `/api/payments/stats` | Estadísticas por estado |
| GET | `/api/payments/:id` | Consultar pago individual |
| POST | `/api/payments/:id/confirm` | PENDING → APPROVED |
| POST | `/api/payments/:id/reject` | PENDING → REJECTED |

## Idempotencia

Incluir el header `Idempotency-Key: <uuid>` en POST. Si se repite la misma key, retorna el resultado cacheado (HTTP 200) sin re-procesar.

## Estado persistido

Solo en memoria. Reiniciar el servidor limpia todos los pagos.
