import { Request, Response, NextFunction } from 'express';

/**
 * Middleware de autenticación — integración con Grupo 2 (Auth).
 *
 * Grupo 2 firma sus JWT con HS256 (secreto simétrico) y, por eso mismo,
 * decidieron NO compartir el secreto con otros grupos (quien lo tuviera
 * podría falsificar tokens de cualquier usuario). La validación se hace
 * entonces llamando a su endpoint `GET /auth/validate` en cada operación
 * sensible, en vez de verificar la firma nosotros mismos offline.
 *
 * Respuestas de /auth/validate:
 *   200 → token válido y cuenta activa. Body: { valid, user_id, email, role, status, ... }
 *   401 → token ausente / inválido / expirado
 *   403 → cuenta deshabilitada
 *
 * Fail-closed: a diferencia de las integraciones opcionales del proyecto
 * (RabbitMQ, Mercado Pago), acá SÍ bloqueamos la operación si Auth no
 * puede confirmar la identidad — es una operación que mueve dinero, no
 * tiene sentido dejarla pasar "en modo degradado".
 */

export interface AuthenticatedUser {
  id: string; // claim `sub` del JWT — UUID único y estable
  email: string;
  role: string;
  status: string;
  businessUserId?: string | null;
}

// Aumenta el tipo de Express.Request para tener req.user tipado en los controllers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'https://auth-minimarket-cloud.onrender.com';
const VALIDATE_TIMEOUT_MS = 5000;

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Falta el token de autenticación (Authorization: Bearer <token>)' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      method: 'GET',
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 401) {
      res.status(401).json({ error: 'Token inválido o expirado' });
      return;
    }

    if (response.status === 403) {
      res.status(403).json({ error: 'La cuenta está deshabilitada' });
      return;
    }

    if (!response.ok) {
      // Cualquier otro código inesperado de Auth: fail-closed también.
      console.error(`[Auth] Respuesta inesperada de /auth/validate: ${response.status}`);
      res.status(503).json({ error: 'Servicio de autenticación no disponible' });
      return;
    }

    const data = (await response.json()) as {
      valid: boolean;
      user_id: string;
      email: string;
      role: string;
      status: string;
      business_user_id?: string | null;
    };

    req.user = {
      id: data.user_id,
      email: data.email,
      role: data.role,
      status: data.status,
      businessUserId: data.business_user_id ?? null,
    };

    next();
  } catch (err) {
    clearTimeout(timeout);
    // Timeout o servicio de Auth caído: fail-closed. Es una operación de
    // pago, preferimos rechazarla a procesarla sin poder confirmar quién es
    // el usuario.
    console.error('[Auth] No se pudo validar el token (Auth caído o timeout):', (err as Error).message);
    res.status(503).json({ error: 'Servicio de autenticación no disponible, intentá nuevamente' });
  }
}