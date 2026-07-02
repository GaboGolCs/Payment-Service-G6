/**
 * Configuración centralizada de variables de entorno.
 *
 * Nota: la validación "fail-fast" de variables obligatorias (DATABASE_URL)
 * se hace explícitamente vía assertRequiredEnv(), invocada al arrancar el
 * servidor en src/app.ts — no al importar este módulo. Así, importar este
 * archivo en tests unitarios (donde DATABASE_URL puede no estar seteada
 * porque los repositorios están mockeados) no rompe la suite.
 */

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: Number(optional('PORT', '3000')),

  // Base pública del servicio (usada para construir la notification_url del webhook)
  BASE_URL: optional('BASE_URL', 'http://localhost:3000'),

  DATABASE_URL: optional('DATABASE_URL', ''),

  // Mercado Pago (Checkout Pro)
  MP_ACCESS_TOKEN: optional('MP_ACCESS_TOKEN', ''),
  MP_PUBLIC_KEY: optional('MP_PUBLIC_KEY', ''),
  MP_WEBHOOK_SECRET: optional('MP_WEBHOOK_SECRET', ''),

  // URLs de retorno del checkout (frontend, Grupo 1)
  FRONTEND_SUCCESS_URL: optional('FRONTEND_SUCCESS_URL', 'http://localhost:5173/payment/success'),
  FRONTEND_FAILURE_URL: optional('FRONTEND_FAILURE_URL', 'http://localhost:5173/payment/failure'),
  FRONTEND_PENDING_URL: optional('FRONTEND_PENDING_URL', 'http://localhost:5173/payment/pending'),
};

/** Fail-fast al arrancar el servidor real (no se llama en tests). */
export function assertRequiredEnv(): void {
  if (!env.DATABASE_URL) {
    throw new Error('[env] Falta la variable de entorno obligatoria: DATABASE_URL');
  }
  if (!env.MP_ACCESS_TOKEN) {
    console.warn(
      '[env] MP_ACCESS_TOKEN no configurado: la creación de pagos NO generará init_point de Mercado Pago (modo degradado/dev).'
    );
  }
}

export function assertMercadoPagoConfigured(): void {
  if (!env.MP_ACCESS_TOKEN) {
    throw new Error(
      '[env] MP_ACCESS_TOKEN no configurado. Define tus credenciales de prueba de Mercado Pago (ver README).'
    );
  }
}
