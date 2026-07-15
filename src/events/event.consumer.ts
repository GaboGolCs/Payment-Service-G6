import amqp from 'amqplib';

export interface KnownOrder {
  orderId: string;
  orderNumber?: string;
  amount?: number;
  description?: string;
  receivedAt: string;
}

const MAX_KNOWN_ORDERS = 100;
const QUEUE_NAME = 'g6-payment-service';
const EXCHANGE_NAME = 'fishmarket';
// Escuchamos cualquier evento que empiece con "order." (order.created,
// order.updated, etc.) para no perder mensajes si Grupo 5 cambia el nombre
// exacto del evento más adelante.
const ROUTING_PATTERN = 'order.*';

class EventConsumer {
  private connection: any = null;
  private channel: any = null;
  private knownOrders: Map<string, KnownOrder> = new Map();

  async start() {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      console.warn('[EventConsumer] RABBITMQ_URL no configurada, no se inicia el consumer.');
      return;
    }
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();

      await this.channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
      const q = await this.channel.assertQueue(QUEUE_NAME, { durable: true });
      await this.channel.bindQueue(q.queue, EXCHANGE_NAME, ROUTING_PATTERN);

      console.log(`[EventConsumer] Escuchando "${ROUTING_PATTERN}" en cola "${QUEUE_NAME}" (exchange "${EXCHANGE_NAME}").`);

      this.channel.consume(q.queue, (msg: any) => {
        if (!msg) return;
        try {
          this.handleMessage(msg.content.toString(), msg.fields.routingKey);
          this.channel.ack(msg);
        } catch (err) {
          console.error('[EventConsumer] Error procesando mensaje, se descarta:', err);
          // No relanzamos el mensaje a la cola (nack sin requeue) para no
          // bloquear el consumer con un mensaje malformado en loop infinito.
          this.channel.nack(msg, false, false);
        }
      });

      this.connection.on('error', (err: Error) => {
        console.error('[EventConsumer] Error de conexión:', err.message);
      });
      this.connection.on('close', () => {
        console.warn('[EventConsumer] Conexión cerrada, reintentando en 5s...');
        setTimeout(() => this.start(), 5000);
      });
    } catch (error) {
      console.error('[EventConsumer] Error conectando a RabbitMQ:', error);
      setTimeout(() => this.start(), 5000);
    }
  }

  private handleMessage(raw: string, routingKey: string) {
    const parsed = JSON.parse(raw);
    // El evento puede venir envuelto (como el tuyo: { eventType, payload })
    // o plano. Probamos varias rutas comunes para no depender de un único formato.
    const payload = parsed.payload || parsed.data || parsed;

    const orderId =
      payload.orderId || payload.id || payload.order_id ||
      parsed.orderId || parsed.id;

    if (!orderId || typeof orderId !== 'string') {
      console.warn(`[EventConsumer] Mensaje "${routingKey}" sin orderId reconocible, se ignora:`, raw);
      return;
    }

    const order: KnownOrder = {
      orderId,
      orderNumber: payload.orderNumber || payload.order_number,
      amount: payload.amount ?? payload.totalAmount ?? payload.total_amount,
      description: payload.description || payload.orderNumber || undefined,
      receivedAt: new Date().toISOString(),
    };

    this.knownOrders.set(orderId, order);

    // Límite simple para no crecer sin control en memoria
    if (this.knownOrders.size > MAX_KNOWN_ORDERS) {
      const oldestKey = this.knownOrders.keys().next().value;
      if (oldestKey) this.knownOrders.delete(oldestKey);
    }

    console.log(`[EventConsumer] Orden registrada desde "${routingKey}": ${orderId}`);
  }

  getKnownOrders(): KnownOrder[] {
    return Array.from(this.knownOrders.values()).sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );
  }
}

export const eventConsumer = new EventConsumer();
export default eventConsumer;
