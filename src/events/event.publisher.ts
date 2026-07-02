export type EventName = 'PaymentApproved' | 'PaymentRejected' | 'PaymentPending';

export interface PaymentEvent {
  eventId: string;
  eventName: EventName;
  paymentId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/**
 * Publicador de eventos vía webhooks HTTP.
 *
 * Reemplaza la integración anterior con RabbitMQ: el servicio ahora depende
 * únicamente de Supabase (Postgres) + HTTP estándar, sin brokers adicionales
 * que levantar en producción.
 *
 * Cada grupo consumidor (5, 9, 10) expone su propio endpoint HTTP y se
 * "suscribe" agregando su URL a la variable de entorno correspondiente a la
 * routing key que le interesa. Varias URLs por evento van separadas por coma.
 *
 * Config (.env):
 *   WEBHOOK_URLS_PAYMENT_PENDING="https://grupo9.example.com/webhooks/payments"
 *   WEBHOOK_URLS_PAYMENT_APPROVED="https://grupo5.example.com/hook,https://grupo10.example.com/hook"
 *   WEBHOOK_URLS_PAYMENT_REJECTED="https://grupo9.example.com/hook,https://grupo10.example.com/hook"
 *
 * Cada suscriptor recibe un POST con el mismo body que antes viajaba como
 * mensaje de RabbitMQ (PaymentEvent), así que el contrato de datos no cambia
 * para los otros grupos — solo el transporte (HTTP en vez de AMQP).
 */
class EventPublisher {
  /**
   * Se mantiene por compatibilidad con el resto del código (app.ts la
   * invoca al arrancar). Ya no hay conexión persistente que abrir: los
   * webhooks HTTP se disparan on-demand en publish().
   */
  async connect(): Promise<void> {
    console.log('[EventPublisher] Listo (modo HTTP webhooks, sin broker externo)');
  }

  async publish(eventName: EventName, data: Record<string, unknown>): Promise<void> {
    const event: PaymentEvent = {
      eventId: crypto.randomUUID(),
      eventName,
      paymentId: data.paymentId as string,
      timestamp: new Date().toISOString(),
      payload: data,
    };

    // Mismo esquema de routing keys que en la versión con RabbitMQ:
    //   PaymentApproved  → payment.approved  (Grupo 5 pedidos, Grupo 10 reportería)
    //   PaymentRejected  → payment.rejected  (Grupo 9 notificaciones, Grupo 10)
    //   PaymentPending   → payment.pending   (Grupo 9 notificaciones)
    const routingKey = `payment.${eventName.replace('Payment', '').toLowerCase()}`;
    const envVar = `WEBHOOK_URLS_${routingKey.toUpperCase().replace(/\./g, '_')}`;
    const urls = (process.env[envVar] || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      console.log(
        `[EventPublisher] ${eventName} (${event.eventId}) → sin suscriptores configurados en ${envVar}`
      );
      return;
    }

    // Fan-out best-effort: un consumidor caído no debe afectar a los demás
    // ni bloquear la respuesta HTTP al cliente original (eventual consistency,
    // igual que antes con el exchange topic de RabbitMQ).
    const results = await Promise.allSettled(urls.map((url) => this.deliver(url, event)));

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`[EventPublisher] ${eventName} (${event.eventId}) → OK ${urls[i]}`);
      } else {
        console.error(`[EventPublisher] ${eventName} (${event.eventId}) → FALLÓ ${urls[i]}:`, r.reason);
      }
    });
  }

  /** POST con timeout y 1 reintento; no lanza hasta agotar los intentos. */
  private async deliver(url: string, event: PaymentEvent, attempt = 1): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (attempt < 2) {
        return this.deliver(url, event, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const eventPublisher = new EventPublisher();
