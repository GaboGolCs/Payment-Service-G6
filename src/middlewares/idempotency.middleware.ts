import { Request, Response, NextFunction } from 'express';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.connect().catch(console.error);

const TTL_SECONDS = 86400; // 24 horas

/**
 * Middleware de idempotencia basado en Redis.
 *
 * Flujo:
 * 1. Si no hay Idempotency-Key header → procesar normalmente
 * 2. Si hay key y existe en Redis → devolver resultado cacheado (no re-procesar)
 * 3. Si hay key y NO existe → interceptar respuesta exitosa y guardarla en Redis
 *
 * Esto resuelve el caso obligatorio: dos confirmaciones del mismo pago
 * con el mismo Idempotency-Key solo procesan una vez.
 */
export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    return next();
  }

  const cacheKey = `idempotency:${idempotencyKey}`;

  try {
    const cached = await redis.get(cacheKey);

    if (cached) {
      console.log(`[Idempotency] Cache HIT for key: ${idempotencyKey}`);
      return res.status(200).json(JSON.parse(cached));
    }

    // Interceptar la respuesta para persistirla
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) {
        redis
          .setEx(cacheKey, TTL_SECONDS, JSON.stringify(body))
          .catch((err) => console.error('[Idempotency] Redis set error:', err));
        console.log(`[Idempotency] Cached response for key: ${idempotencyKey}`);
      }
      return originalJson(body);
    };

    next();
  } catch (err) {
    // Redis no disponible: degraded mode (procesar sin idempotencia)
    console.error('[Idempotency] Redis unavailable, proceeding without cache:', err);
    next();
  }
};
