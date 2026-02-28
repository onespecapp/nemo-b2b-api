import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config, log } from './config';
import { generalRateLimiter } from './middleware/rate-limit';
import { globalErrorHandler } from './middleware/error-handler';
import { registerRoutes } from './routes';

// ============================================
// EXPRESS APP
// ============================================

const app = express();
const server = createServer(app);

// Trust first proxy (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when behind reverse proxy)
app.set('trust proxy', 1);

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
  console.log('Nemo B2B AI Receptionist API Started');
  console.log('====================================');
  console.log(`Port: ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Webhook URL: ${config.apiUrl}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  POST /api/webhooks/telnyx/inbound  (inbound call handler)');
  console.log('  GET  /api/calls                    (call history)');
  console.log('  GET  /api/appointments             (appointment CRUD)');
  console.log('  GET  /api/appointments/availability (slot availability)');
  console.log('  POST /api/appointments/book-inbound (book from call)');
  console.log('  POST /api/calls/:id/transfer       (call transfer)');
  console.log('  GET  /api/messages                 (messages)');
  console.log('  GET  /api/business/config           (receptionist config)');
  console.log('');
});

export default app;
