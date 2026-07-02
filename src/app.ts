import 'dotenv/config';
import express from 'express';
import paymentRoutes from './routes/payment.routes';
import { eventPublisher } from './events/event.publisher';
import { env, assertRequiredEnv } from './config/env';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
app.use('/api/payments', paymentRoutes);

// Health check (usado por Render y por Grupo 5/10 para verificar disponibilidad)
app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'payment-service', timestamp: new Date().toISOString() });
});

// 404 estándar
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Error handler global — formato estándar { error, code? }
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

(async () => {
  try {
    assertRequiredEnv();
    await eventPublisher.connect();
    app.listen(env.PORT, () => {
      console.log(`[Payment Service] Running on http://localhost:${env.PORT}`);
      console.log(`[Payment Service] Health: http://localhost:${env.PORT}/health`);
      console.log(`[Payment Service] MP webhook: ${env.BASE_URL}/api/payments/webhook`);
    });
  } catch (err) {
    console.error('[Startup] Failed to start service:', err);
    process.exit(1);
  }
})();

export default app;
