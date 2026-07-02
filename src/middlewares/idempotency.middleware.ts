import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Middleware de idempotencia basado en Postgres (Supabase).
 *
 * Reemplaza la implementación anterior basada en Redis usando el modelo
 * `IdempotencyRecord`, que ya estaba declarado en schema.prisma pero sin
 * usar. Así el servicio depende únicamente de Supabase, sin infraestructura
 * adicional (Redis) que levantar en producción.
 *
 * Flujo:
 * 1. Si no hay Idempotency-Key header → procesar normalmente
 * 2. Si hay key y existe un registro vigente (< 24h) → devolver resultado cacheado (no re-procesar)
 * 3. Si hay key y NO existe (o expiró) → interceptar respuesta exitosa y guardarla
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

  try {
    const cached = await prisma.idempotencyRecord.findUnique({
      where: { key: idempotencyKey },
    });

    if (cached && Date.now() - cached.createdAt.getTime() < TTL_MS) {
      console.log(`[Idempotency] Cache HIT for key: ${idempotencyKey}`);
      return res.status(200).json(cached.result as object);
    }

    // Interceptar la respuesta para persistirla
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) {
        const paymentId = (body as { id?: string; paymentId?: string })?.id
          ?? (body as { id?: string; paymentId?: string })?.paymentId
          ?? 'unknown';

        prisma.idempotencyRecord
          .upsert({
            where: { key: idempotencyKey },
            create: { key: idempotencyKey, paymentId, result: body as object },
            update: { paymentId, result: body as object, createdAt: new Date() },
          })
          .catch((err: unknown) => console.error('[Idempotency] Error guardando registro:', err));

        console.log(`[Idempotency] Cached response for key: ${idempotencyKey}`);
      }
      return originalJson(body);
    };

    next();
  } catch (err) {
    // Postgres no disponible: degraded mode (procesar sin idempotencia)
    console.error('[Idempotency] DB unavailable, proceeding without cache:', err);
    next();
  }
};
