import express from 'express';
import paymentRoutes from './routes/payment.routes';
import { eventPublisher } from './events/event.publisher';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
app.use('/api/payments', paymentRoutes);

// Health check
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'payment-service', timestamp: new Date().toISOString() });
});

// Error handler global
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await eventPublisher.connect();
    app.listen(PORT, () => {
      console.log(`[Payment Service] Running on http://localhost:${PORT}`);
      console.log(`[Payment Service] Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('[Startup] Failed to connect to RabbitMQ:', err);
    process.exit(1);
  }
})();

export default app;
