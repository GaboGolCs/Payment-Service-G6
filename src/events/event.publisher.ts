import amqp from 'amqplib';

export type EventName = 'PaymentApproved' | 'PaymentRejected' | 'PaymentPending';

export interface PaymentEvent {
  eventId: string;
  eventName: EventName;
  paymentId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

class EventPublisher {
  private channel: amqp.Channel | null = null;
  private readonly EXCHANGE = 'payments.events';

  async connect() {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    this.channel = await conn.createChannel();
    // Exchange tipo topic: permite que Grupos 5, 9 y 10 filtren por routing key
    await this.channel.assertExchange(this.EXCHANGE, 'topic', { durable: true });
    console.log('[EventPublisher] Connected to RabbitMQ');
  }

  async publish(eventName: EventName, data: Record<string, unknown>): Promise<void> {
    if (!this.channel) await this.connect();

    const event: PaymentEvent = {
      eventId: crypto.randomUUID(),
      eventName,
      paymentId: data.paymentId as string,
      timestamp: new Date().toISOString(),
      payload: data,
    };

    // Routing keys:
    //   PaymentApproved  → payment.approved  (Grupo 5 pedidos, Grupo 10 reportería)
    //   PaymentRejected  → payment.rejected  (Grupo 9 notificaciones, Grupo 10)
    //   PaymentPending   → payment.pending   (Grupo 9 notificaciones)
    const routingKey = `payment.${eventName.replace('Payment', '').toLowerCase()}`;

    this.channel!.publish(
      this.EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        messageId: event.eventId,
        timestamp: Date.now(),
        contentType: 'application/json',
      }
    );

    console.log(`[EventPublisher] Published ${eventName} (${event.eventId}) → ${routingKey}`);
  }
}

export const eventPublisher = new EventPublisher();
