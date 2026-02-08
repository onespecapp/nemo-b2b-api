import { Express } from 'express';
import healthRouter from './health';
import templatesRouter from './templates';
import callsRouter from './calls';
import webhooksRouter from './webhooks';
import testCallRouter from './test-call';
import aiCallRouter from './ai-call';
import appointmentsRouter from './appointments';
import campaignsRouter from './campaigns';
import campaignCallbacksRouter from './campaign-callbacks';

export function registerRoutes(app: Express) {
  app.use(healthRouter);
  app.use(templatesRouter);
  app.use(callsRouter);
  app.use(webhooksRouter);
  app.use(testCallRouter);
  app.use(aiCallRouter);
  app.use(appointmentsRouter);
  app.use(campaignsRouter);
  app.use(campaignCallbacksRouter);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });
}
