import amqp from 'amqplib';

export class EventPublisher {
  // Usamos "any" aquí temporalmente para romper el conflicto de tipos de la librería en esta versión de TS
  private channel: any = null;
  private connection: any = null;

  constructor() {
    this.init();
  }

  private async init() {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      console.warn('[EventPublisher] RABBITMQ_URL no configurada.');
      return;
    }
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();
      
      if (this.channel) {
        await this.channel.assertExchange('payments.events', 'topic', { durable: true });
        console.log('[EventPublisher] Conectado a RabbitMQ, exchange "payments.events" listo.');
      }
    } catch (error) {
      console.error('[EventPublisher] Error conectando a RabbitMQ:', error);
    }
  }

  async publish(eventName: string, payload: Record<string, unknown>) {
    try {
      const url = process.env.RABBITMQ_URL;
      if (!url) return;

      if (!this.connection) {
        this.connection = await amqp.connect(url);
      }
      if (!this.channel) {
        this.channel = await this.connection.createChannel();
      }

      if (!this.channel) {
        throw new Error('[EventPublisher] No se pudo obtener un canal activo de RabbitMQ.');
      }

      const exchange = 'payments.events';
      const routingKey = eventName.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase();
      
      const messageBuffer = Buffer.from(JSON.stringify({
        eventId: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
        eventType: eventName,
        producer: 'G6-PaymentService',
        payload
      }));

      this.channel.publish(exchange, routingKey, messageBuffer, { persistent: true });
      console.log(`[EventPublisher] ${eventName} → publicado en "${routingKey}"`);
    } catch (error) {
      console.error(`[EventPublisher] Error publicando evento ${eventName}:`, error);
    }
  }
}

export const eventPublisher = new EventPublisher();
export default eventPublisher;