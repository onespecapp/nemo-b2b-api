import { Router, Request, Response } from 'express';
import { config } from '../config';
import { livekitEnabled } from '../clients/livekit';

const router = Router();

// Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'nemo-b2b-api',
    version: '1.1.0',
    environment: config.nodeEnv,
    geminiEnabled: livekitEnabled,
    timestamp: new Date().toISOString()
  });
});

export default router;
