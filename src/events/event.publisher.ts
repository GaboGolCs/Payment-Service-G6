import * as amqp from 'amqplib';

export type EventName = 'PaymentApproved' | 'PaymentRejected' | 'PaymentPending';

export interface PaymentEvent {
  eventId: string;
  eventName: EventName;
  paymentId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const EXCHANGE = 'payments.events';

/**
 * Publicador de eventos vía RabbitMQ (CloudAMQP), siguiendo la "Guía Base:
 * Integración de Microservicios con RabbitMQ" acordada entre G5/G6/G9/G10.
 *
 * - Protocolo: AMQP vía `amqplib`.
 * - Exchange: `payments.events`, tipo `topic`, durable.
 * - Routing keys: payment.pending | payment.approved | payment.rejected.
 * - Serialización: JSON.stringify(...) → Buffer.from(...), como pide la guía.
 * - Persistencia: mensajes marcados `persistent: true` para sobrevivir a un
 *   reinicio del broker mientras no hayan sido consumidos.
 *
 * Cada grupo consumidor (5, 9, 10) declara su propia cola y la bindea al
 * exchange con las routing keys que le interesan — no necesitamos conocer
 * sus URLs ni configurarlas acá (a diferencia del esquema anterior de
 * webhooks HTTP punto a punto).
 *
 * Resiliencia: si `RABBITMQ_URL` no está configurada o el broker no está
 * disponible, el servicio sigue funcionando con normalidad (crear/consultar/
 * confirmar/rechazar pagos vía REST no depende de RabbitMQ) — solo se
 * pierde la publicación de eventos, que queda logueada como advertencia.
 * Esto evita que un broker caído tumbe todo el servicio de pagos.
 */
class EventPublisher {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    const url = process.env.RABBITMQ_URL;

    if (!url) {
      console.warn(
        '[EventPublisher] RABBITMQ_URL no configurada — el servicio arranca igual, ' +
          'pero no se van a publicar eventos hasta que se configure.'
      );
      return;
    }

    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });

      this.connection.on('error', (err) => {
        console.error('[EventPublisher] Conexión RabbitMQ perdida:', err.message);
        this.connection = null;
        this.channel = null;
      });
      this.connection.on('close', () => {
        console.warn('[EventPublisher] Conexión RabbitMQ cerrada.');
        this.connection = null;
        this.channel = null;
      });

      console.log(`[EventPublisher] Conectado a RabbitMQ, exchange "${EXCHANGE}" listo.`);
    } catch (err) {
      // No relanzamos: un broker caído no debe impedir que el servicio de
      // pagos arranque y siga respondiendo por REST.
      console.error(
        '[EventPublisher] No se pudo conectar a RabbitMQ, se continúa sin publicar eventos:',
        (err as Error).message
      );
      this.connection = null;
      this.channel = null;
    }
  }

  async publish(eventName: EventName, data: Record<string, unknown>): Promise<void> {
    const event: PaymentEvent = {
      eventId: crypto.randomUUID(),
      eventName,
      paymentId: data.paymentId as string,
      timestamp: new Date().toISOString(),
      payload: data,
    };

    // payment.pending | payment.approved | payment.rejected
    const routingKey = `payment.${eventName.replace('Payment', '').toLowerCase()}`;

    if (!this.channel) {
      console.warn(
        `[EventPublisher] ${eventName} (${event.eventId}) → no publicado, sin canal activo a RabbitMQ.`
      );
      return;
    }

    try {
      const buffer = Buffer.from(JSON.stringify(event));
      const ok = this.channel.publish(EXCHANGE, routingKey, buffer, { persistent: true });

      if (ok) {
        console.log(`[EventPublisher] ${eventName} (${event.eventId}) → publicado en "${routingKey}"`);
      } else {
        // Buffer interno del canal lleno (backpressure); no es un error fatal,
        // pero lo dejamos visible para monitoreo.
        console.warn(`[EventPublisher] ${eventName} (${event.eventId}) → backpressure en "${routingKey}"`);
      }
    } catch (err) {
      console.error(`[EventPublisher] ${eventName} (${event.eventId}) → error al publicar:`, err);
    }
  }
}

export const eventPublisher = new EventPublisher();