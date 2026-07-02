import crypto from 'crypto';
import { MercadoPagoConfig, Preference, Payment as MPPayment } from 'mercadopago';
import { env, assertMercadoPagoConfigured } from '../config/env';

let client: MercadoPagoConfig | null = null;

function getClient(): MercadoPagoConfig {
  assertMercadoPagoConfigured();
  if (!client) {
    client = new MercadoPagoConfig({
      accessToken: env.MP_ACCESS_TOKEN,
      options: { timeout: 5000 },
    });
  }
  return client;
}

export interface CreatePreferenceParams {
  paymentId: string; // nuestro Payment.id -> external_reference
  amount: number;
  currency: string;
  description?: string;
  payerEmail?: string;
}

export interface CreatePreferenceResult {
  preferenceId: string;
  initPoint: string;
}

export const mercadoPagoService = {
  /**
   * Crea una preferencia de Checkout Pro. El `external_reference` es el id
   * del Payment en nuestra base, lo que permite reconciliar el webhook con
   * el registro correcto sin ambigüedad.
   */
  createPreference: async (params: CreatePreferenceParams): Promise<CreatePreferenceResult> => {
    const preference = new Preference(getClient());

    const response = await preference.create({
      body: {
        items: [
          {
            id: params.paymentId,
            title: params.description || `Pago pedido ${params.paymentId}`,
            quantity: 1,
            unit_price: params.amount,
            currency_id: params.currency,
          },
        ],
        payer: params.payerEmail ? { email: params.payerEmail } : undefined,
        external_reference: params.paymentId,
        notification_url: `${env.BASE_URL}/api/payments/webhook`,
        back_urls: {
          success: env.FRONTEND_SUCCESS_URL,
          failure: env.FRONTEND_FAILURE_URL,
          pending: env.FRONTEND_PENDING_URL,
        },
        auto_return: 'approved',
        statement_descriptor: 'VIGIA INDUSTRIAL',
      },
    });

    if (!response.id || !response.init_point) {
      throw new Error('Mercado Pago no devolvió preferenceId/init_point');
    }

    return { preferenceId: response.id, initPoint: response.init_point };
  },

  /**
   * Consulta el estado real de un pago directamente en la API de Mercado Pago.
   * NUNCA confiamos ciegamente en el body del webhook: siempre re-consultamos
   * el recurso con el id recibido, tal como recomienda la documentación oficial.
   */
  getPayment: async (mpPaymentId: string) => {
    const payment = new MPPayment(getClient());
    return payment.get({ id: mpPaymentId });
  },

  /**
   * Verifica la firma `x-signature` que Mercado Pago envía en cada webhook.
   * Manifest: "id:{data.id};request-id:{x-request-id};ts:{ts};"
   * Ver: https://www.mercadopago.com/developers -> Notificaciones webhook -> Firma
   */
  verifySignature: (params: {
    xSignature: string | undefined;
    xRequestId: string | undefined;
    dataId: string;
  }): boolean => {
    if (!env.MP_WEBHOOK_SECRET) {
      // Sin secret configurado (p.ej. ambiente de pruebas): no bloqueamos,
      // pero se registra para visibilidad.
      console.warn('[MercadoPago] MP_WEBHOOK_SECRET no configurado, se omite verificación de firma');
      return true;
    }
    if (!params.xSignature) return false;

    const parts = Object.fromEntries(
      params.xSignature.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k?.trim(), v?.trim()];
      })
    );
    const ts = parts['ts'];
    const receivedHash = parts['v1'];
    if (!ts || !receivedHash) return false;

    const manifest = `id:${params.dataId};request-id:${params.xRequestId || ''};ts:${ts};`;
    const computedHash = crypto
      .createHmac('sha256', env.MP_WEBHOOK_SECRET)
      .update(manifest)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(receivedHash));
  },
};

/** Traduce el estado de Mercado Pago a nuestra máquina de estados interna */
export function mapMercadoPagoStatus(mpStatus: string): 'APPROVED' | 'REJECTED' | 'PENDING' {
  switch (mpStatus) {
    case 'approved':
      return 'APPROVED';
    case 'rejected':
    case 'cancelled':
    case 'charged_back':
      return 'REJECTED';
    default:
      // pending, in_process, in_mediation, authorized, refunded → tratados como PENDING
      // (refunded/authorized podrían modelarse como estados propios más adelante)
      return 'PENDING';
  }
}
