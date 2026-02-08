import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config, log } from './config';
import { googleAI } from './clients/google-ai';
import { generalRateLimiter } from './middleware/rate-limit';
import { globalErrorHandler } from './middleware/error-handler';
import { registerRoutes } from './routes';
import { setupTelnyxMediaWebSocket } from './websocket/telnyx-media';
import { startReminderScheduler } from './schedulers/reminder';
import { startCampaignScheduler } from './schedulers/campaign';

// ============================================
// EXPRESS APP
// ============================================

const app = express();
const server = createServer(app);

// Trust first proxy (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when behind reverse proxy)
app.set('trust proxy', 1);

// WebSocket setup
setupTelnyxMediaWebSocket(server);

// Middleware - Security
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or Postman in dev)
    if (!origin) {
      return callback(null, true);
    }

    // In development, allow all origins
    if (config.nodeEnv === 'development') {
      return callback(null, true);
    }

    // In production, check against whitelist
    if (config.allowedOrigins.length === 0) {
      log.error('ALLOWED_ORIGINS not configured for production');
      return callback(null, true); // Fall back to allowing (log warning)
    }

    if (config.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    log.debug('CORS blocked request from origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // Limit request body size (transcripts can be large)
app.use(generalRateLimiter); // Apply general rate limiting

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  log.debug(`${req.method} ${req.path}`, { query: req.query, body: req.body });
  next();
});

// Routes
registerRoutes(app);

// Global error handler (AFTER routes)
app.use(globalErrorHandler);

// ============================================
// START SERVER
// ============================================

server.listen(config.port, () => {
  console.log('');
  console.log('🚀 Nemo B2B API Started');
  console.log('========================');
  console.log(`📍 Port: ${config.port}`);
  console.log(`🌍 Environment: ${config.nodeEnv}`);
  console.log(`📞 Telnyx Phone: ${config.telnyxPhoneNumber}`);
  console.log(`🔗 Webhook URL: ${config.apiUrl}`);
  console.log(`🔌 WebSocket URL: ${config.wsUrl}`);
  console.log(`🤖 Gemini Live: ${googleAI ? 'Enabled' : 'Disabled (missing GOOGLE_AI_API_KEY)'}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /api/appointments/pending-reminders');
  console.log('  POST /api/appointments/:id/trigger-call');
  console.log('  GET  /api/call-logs?business_id=xxx');
  console.log('  POST /api/test-call          (basic TTS)');
  console.log('  POST /api/ai-call            (Gemini Live AI)');
  console.log('  --- Campaigns ---');
  console.log('  GET  /api/campaigns');
  console.log('  POST /api/campaigns');
  console.log('  GET  /api/campaigns/:id');
  console.log('  PATCH /api/campaigns/:id');
  console.log('  DELETE /api/campaigns/:id');
  console.log('  POST /api/campaigns/:id/toggle');
  console.log('  GET  /api/campaigns/:id/calls');
  console.log('  GET  /api/campaigns/:id/stats');
  console.log('  GET  /api/campaign-templates/:type/:category');
  console.log('');

  // Start schedulers
  startReminderScheduler();
  startCampaignScheduler();
});

export default app;
