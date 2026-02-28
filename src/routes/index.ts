import { Express } from 'express';
import healthRouter from './health';
import callsRouter from './calls';
import webhooksRouter from './webhooks';
import appointmentsRouter from './appointments';
import inboundRouter from './inbound';
import businessConfigRouter from './business-config';
import messagesRouter from './messages';
import callTransferRouter from './call-transfer';

export function registerRoutes(app: Express) {
  app.use(healthRouter);
  app.use(callsRouter);
  app.use(webhooksRouter);
  app.use(appointmentsRouter);
  app.use(inboundRouter);
  app.use(businessConfigRouter);
  app.use(messagesRouter);
  app.use(callTransferRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });
}
