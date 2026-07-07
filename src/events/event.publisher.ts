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
 */
export class EventPublisher { // <-- Agregamos "export" aquí para que los tipos e importaciones nombradas funcionen
  /**
   * Se mantiene por compatibilidad con el resto del código (app.ts la
   * invoca al arrancar). Ya no hay conexión persistente que abrir.
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

// EXPORTACIONES DUALES (Esto remedia instantáneamente los fallos de importación de tus controladores y servicios)
export const eventPublisher = new EventPublisher();
export default eventPublisher;