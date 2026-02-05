import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Telnyx from 'telnyx';
import dotenv from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { SipClient, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

dotenv.config();

// ============================================
// CONFIGURATION & VALIDATION
// ============================================

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELNYX_API_KEY',
  'TELNYX_CONNECTION_ID',
  'TELNYX_PHONE_NUMBER',
];

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Copy .env.example to .env and fill in the values');
  process.exit(1);
}

const config = {
  port: parseInt(process.env.PORT || '6001'),
  apiUrl: process.env.API_URL || `http://localhost:${process.env.PORT || 6001}`,
  wsUrl: process.env.WS_URL || `ws://localhost:${process.env.PORT || 6001}`,
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  telnyxApiKey: process.env.TELNYX_API_KEY!,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID!,
  telnyxPhoneNumber: process.env.TELNYX_PHONE_NUMBER!,
  telnyxWebhookSecret: process.env.TELNYX_WEBHOOK_SECRET || '',
  googleAiApiKey: process.env.GOOGLE_AI_API_KEY,
  nodeEnv: process.env.NODE_ENV || 'development',
  // LiveKit config (optional - for Gemini voice)
  livekitUrl: process.env.LIVEKIT_URL || '',
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitSipTrunkId: process.env.SIP_TRUNK_ID || '',
  livekitAgentName: process.env.LIVEKIT_AGENT_NAME || 'nemo_b2b_agent',
  // Security config
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || [],
  internalApiKey: process.env.INTERNAL_API_KEY || '',
};

// LiveKit clients (initialized if config is present)
const livekitEnabled = !!(config.livekitUrl && config.livekitApiKey && config.livekitApiSecret && config.livekitSipTrunkId);
let sipClient: SipClient | null = null;
let roomClient: RoomServiceClient | null = null;
let agentDispatch: AgentDispatchClient | null = null;

if (livekitEnabled) {
  sipClient = new SipClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  roomClient = new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  agentDispatch = new AgentDispatchClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  console.log('✅ LiveKit integration enabled');
  console.log(`   Agent: ${config.livekitAgentName}`);
} else {
  console.log('⚠️ LiveKit not configured - using basic Telnyx TTS for calls');
}

// ============================================
// LOGGING UTILITY
// ============================================

const log = {
  info: (message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`, data ? JSON.stringify(data) : '');
  },
  error: (message: string, error?: any) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, error?.message || error || '');
  },
  debug: (message: string, data?: any) => {
    if (config.nodeEnv === 'development') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] DEBUG: ${message}`, data ? JSON.stringify(data) : '');
    }
  },
};

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Phone number validation regex (E.164 format)
const E164_PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validate phone number format
function isValidPhoneNumber(phone: string | string[] | undefined): phone is string {
  if (typeof phone !== 'string') return false;
  return E164_PHONE_REGEX.test(phone);
}

// Validate UUID format
function isValidUUID(id: string | string[] | undefined): id is string {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id);
}

// Extended Request type with user info
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    business_id?: string;
    email?: string;
  };
}

// Authentication middleware using Supabase JWT
const authenticateUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify the JWT with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      log.debug('Auth failed', { error: error?.message });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get the user's business
    const { data: business } = await supabase
      .from('b2b_businesses')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email,
      business_id: business?.id,
    };

    next();
  } catch (error) {
    log.error('Authentication error', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Internal API key authentication (for agent callbacks)
const authenticateInternal = (req: Request, res: Response, next: NextFunction) => {
  // Skip auth if no internal API key is configured (development mode)
  if (!config.internalApiKey) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.substring(7);

  if (token !== config.internalApiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};

// Verify business ownership for IDOR protection
const verifyBusinessOwnership = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const businessId = req.query.business_id as string || req.body?.business_id;

  if (!businessId) {
    return next();
  }

  if (!req.user?.business_id) {
    return res.status(403).json({ error: 'No business associated with user' });
  }

  if (businessId !== req.user.business_id) {
    log.debug('Business ownership check failed', {
      requested: businessId,
      owned: req.user.business_id
    });
    return res.status(403).json({ error: 'Access denied to this business data' });
  }

  next();
};

// Telnyx webhook signature validation
const validateTelnyxWebhook = (req: Request, res: Response, next: NextFunction) => {
  // Skip validation if no webhook secret configured (development)
  if (!config.telnyxWebhookSecret) {
    log.debug('Telnyx webhook validation skipped (no secret configured)');
    return next();
  }

  const signature = req.headers['telnyx-signature-ed25519'] as string;
  const timestamp = req.headers['telnyx-timestamp'] as string;

  if (!signature || !timestamp) {
    log.error('Missing Telnyx webhook signature headers');
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Verify timestamp is recent (within 5 minutes)
  const timestampAge = Math.abs(Date.now() - parseInt(timestamp) * 1000);
  if (timestampAge > 5 * 60 * 1000) {
    log.error('Telnyx webhook timestamp too old', { age: timestampAge });
    return res.status(401).json({ error: 'Webhook timestamp expired' });
  }

  // For production, implement full Ed25519 signature verification
  // This requires the telnyx public key and crypto.verify
  // For now, we do basic timestamp validation

  next();
};

// Rate limiters
const callRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute
  message: { error: 'Too many call requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// CLIENTS
// ============================================

const supabase: SupabaseClient = createClient(config.supabaseUrl, config.supabaseKey);
const telnyx = new Telnyx({ apiKey: config.telnyxApiKey });

// Initialize Google GenAI client if API key is available
const googleAI = config.googleAiApiKey ? new GoogleGenAI({ apiKey: config.googleAiApiKey }) : null;

// ============================================
// GEMINI LIVE SESSION MANAGER
// ============================================

interface GeminiSession {
  callControlId: string;
  liveSession: any;
  systemPrompt: string;
}

// Active Gemini sessions indexed by call control ID
const geminiSessions = new Map<string, GeminiSession>();

// Active Telnyx WebSocket connections indexed by stream ID
const telnyxStreams = new Map<string, { callControlId: string; ws: WebSocket }>();

async function createGeminiLiveSession(callControlId: string, systemPrompt: string): Promise<GeminiSession | null> {
  if (!googleAI) {
    log.error('Google AI client not initialized - missing GOOGLE_AI_API_KEY');
    return null;
  }

  try {
    log.info('Creating Gemini Live session', { callControlId });

    const liveSession = await googleAI.live.connect({
      model: 'gemini-2.0-flash-live-001',
      callbacks: {
        onopen: () => {
          log.info('Gemini Live session opened', { callControlId });
        },
        onmessage: (message: any) => {
          handleGeminiMessage(callControlId, message);
        },
        onerror: (error: any) => {
          log.error('Gemini Live session error', { callControlId, error });
        },
        onclose: () => {
          log.info('Gemini Live session closed', { callControlId });
          geminiSessions.delete(callControlId);
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Aoede', // Pleasant female voice
            },
          },
        },
      },
    });

    const session: GeminiSession = {
      callControlId,
      liveSession,
      systemPrompt,
    };

    geminiSessions.set(callControlId, session);
    log.info('Gemini Live session created successfully', { callControlId });

    return session;
  } catch (error) {
    log.error('Failed to create Gemini Live session', error);
    return null;
  }
}

function handleGeminiMessage(callControlId: string, message: any) {
  try {
    // Find the Telnyx stream for this call
    let telnyxStream: { callControlId: string; ws: WebSocket } | undefined;
    for (const [streamId, stream] of telnyxStreams) {
      if (stream.callControlId === callControlId) {
        telnyxStream = stream;
        break;
      }
    }

    if (!telnyxStream) {
      log.debug('No Telnyx stream found for Gemini response', { callControlId });
      return;
    }

    // Check if this is an audio response
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data) {
          // Send audio to Telnyx
          const audioData = part.inlineData.data;
          
          // Telnyx expects audio in base64 format wrapped in a media message
          const mediaMessage = {
            event: 'media',
            media: {
              payload: audioData, // Already base64 encoded from Gemini
            },
          };
          
          if (telnyxStream.ws.readyState === WebSocket.OPEN) {
            telnyxStream.ws.send(JSON.stringify(mediaMessage));
            log.debug('Sent audio to Telnyx', { callControlId, size: audioData.length });
          }
        }
      }
    }

    // Check if the turn is complete
    if (message.serverContent?.turnComplete) {
      log.debug('Gemini turn complete', { callControlId });
    }
  } catch (error) {
    log.error('Error handling Gemini message', error);
  }
}

async function sendAudioToGemini(callControlId: string, audioData: string) {
  const session = geminiSessions.get(callControlId);
  if (!session) {
    log.debug('No Gemini session for audio', { callControlId });
    return;
  }

  try {
    // Send audio to Gemini Live session
    // Telnyx streams PCMU (G.711 μ-law) at 8kHz
    await session.liveSession.sendRealtimeInput({
      audio: {
        data: audioData,
        mimeType: 'audio/pcmu', 
      },
    });
  } catch (error) {
    log.error('Error sending audio to Gemini', error);
  }
}

async function closeGeminiSession(callControlId: string) {
  const session = geminiSessions.get(callControlId);
  if (session) {
    try {
      await session.liveSession.close();
    } catch (error) {
      log.debug('Error closing Gemini session', error);
    }
    geminiSessions.delete(callControlId);
    log.info('Gemini session closed', { callControlId });
  }
}

// ============================================
// GEMINI TRANSCRIPT ANALYSIS
// ============================================

const VALID_CALL_OUTCOMES = ['ANSWERED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'VOICEMAIL', 'NO_ANSWER', 'FAILED'] as const;

async function analyzeTranscriptWithGemini(
  transcript: Array<{ role: string; content: string }> | null
): Promise<{ summary: string; call_outcome: string } | null> {
  if (!googleAI) {
    log.debug('Gemini transcript analysis skipped: no API key');
    return null;
  }

  if (!transcript || !Array.isArray(transcript)) {
    log.debug('Gemini transcript analysis skipped: no transcript');
    return null;
  }

  // Filter to only agent/user conversation messages (exclude system)
  const conversationMessages = transcript.filter(
    (msg) => msg.role === 'agent' || msg.role === 'user'
  );

  if (conversationMessages.length < 2) {
    log.debug('Gemini transcript analysis skipped: too few messages', { count: conversationMessages.length });
    return null;
  }

  try {
    const formattedTranscript = conversationMessages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n');

    const response = await googleAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze this phone call transcript between an AI appointment reminder agent and a customer.\n\nTranscript:\n${formattedTranscript}\n\nProvide a brief summary and determine the call outcome.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: 'A concise 1-3 sentence summary of the call from the business owner perspective. Focus on what happened and the result.',
            },
            call_outcome: {
              type: Type.STRING,
              description: 'The outcome of the call.',
              enum: [...VALID_CALL_OUTCOMES],
            },
          },
          required: ['summary', 'call_outcome'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      log.error('Gemini transcript analysis: empty response');
      return null;
    }

    const parsed = JSON.parse(text);

    if (!parsed.summary || !parsed.call_outcome) {
      log.error('Gemini transcript analysis: missing fields', parsed);
      return null;
    }

    if (!VALID_CALL_OUTCOMES.includes(parsed.call_outcome)) {
      log.error('Gemini transcript analysis: invalid call_outcome', { call_outcome: parsed.call_outcome });
      return null;
    }

    log.info('Gemini transcript analysis complete', {
      summary_length: parsed.summary.length,
      call_outcome: parsed.call_outcome,
    });

    return { summary: parsed.summary, call_outcome: parsed.call_outcome };
  } catch (error) {
    log.error('Gemini transcript analysis failed', error);
    return null;
  }
}

// ============================================
// EXPRESS APP
// ============================================

const app = express();
const server = createServer(app);

// Trust first proxy (fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when behind reverse proxy)
app.set('trust proxy', 1);

// WebSocket server for Telnyx media streams
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '', `ws://${req.headers.host}`);
  const streamId = url.searchParams.get('stream_id') || `stream-${Date.now()}`;
  const callControlId = url.searchParams.get('call_control_id') || '';
  
  log.info('Telnyx media stream connected', { streamId, callControlId });
  
  telnyxStreams.set(streamId, { callControlId, ws });

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.event === 'media' && message.media?.payload) {
        // Forward audio from Telnyx to Gemini
        await sendAudioToGemini(callControlId, message.media.payload);
      } else if (message.event === 'start') {
        log.info('Telnyx media stream started', { streamId, callControlId: message.start?.call_control_id });
        // Update callControlId if provided in start message
        if (message.start?.call_control_id) {
          const stream = telnyxStreams.get(streamId);
          if (stream) {
            stream.callControlId = message.start.call_control_id;
          }
        }
      } else if (message.event === 'stop') {
        log.info('Telnyx media stream stopped', { streamId });
      }
    } catch (error) {
      log.error('Error processing Telnyx media', error);
    }
  });

  ws.on('close', () => {
    log.info('Telnyx media stream disconnected', { streamId });
    telnyxStreams.delete(streamId);
    
    // Also close the Gemini session
    if (callControlId) {
      closeGeminiSession(callControlId);
    }
  });

  ws.on('error', (error) => {
    log.error('Telnyx media stream error', { streamId, error: error.message });
  });
});

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

// Error handling middleware
const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  // Don't log full error details to avoid leaking sensitive info
  log.error('Unhandled error', { message: err.message, name: err.name });

  // Handle CORS errors specifically
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'nemo-b2b-api',
    version: '1.1.0',
    environment: config.nodeEnv,
    geminiEnabled: livekitEnabled,
    timestamp: new Date().toISOString()
  });
});

// Get upcoming appointments that need reminders (internal use by scheduler)
app.get('/api/appointments/pending-reminders', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const now = new Date();
  
  // Fetch appointments that are scheduled and within the next 24 hours
  // Include appointments up to 1 hour in the past (in case scheduler missed them)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const { data: appointments, error } = await supabase
    .from('b2b_appointments')
    .select(`
      *,
      customer:b2b_customers(*),
      business:b2b_businesses(*)
    `)
    .eq('status', 'SCHEDULED')
    .lte('scheduled_at', new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString())
    .gte('scheduled_at', oneHourAgo.toISOString());

  if (error) {
    log.error('Failed to fetch appointments', error);
    throw error;
  }

  // Filter to only those that need reminders now
  const pendingReminders = appointments?.filter(apt => {
    const scheduledAt = new Date(apt.scheduled_at);
    // Use reminder_minutes_before (default 30 minutes if not set)
    const reminderMinutes = apt.reminder_minutes_before ?? 30;
    const reminderTime = new Date(scheduledAt.getTime() - reminderMinutes * 60 * 1000);
    return reminderTime <= now;
  }) || [];

  log.info(`Found ${pendingReminders.length} pending reminders`);
  res.json({ appointments: pendingReminders, count: pendingReminders.length });
}));

// Trigger a reminder call for an appointment
app.post('/api/appointments/:id/trigger-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  // Validate appointment ID format
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid appointment ID format' });
  }
  
  // Get appointment details with business category
  const { data: appointment, error: fetchError } = await supabase
    .from('b2b_appointments')
    .select(`
      *,
      customer:b2b_customers(*),
      business:b2b_businesses(*)
    `)
    .eq('id', id)
    .single();

  if (fetchError || !appointment) {
    log.error('Appointment not found', { id, error: fetchError });
    return res.status(404).json({ error: 'Appointment not found' });
  }

  const customerPhone = appointment.customer?.phone;
  if (!customerPhone) {
    return res.status(400).json({ error: 'Customer has no phone number' });
  }

  // Validate phone number format
  if (!customerPhone.match(/^\+?[1-9]\d{1,14}$/)) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  // Fetch template based on business category
  const businessCategory = appointment.business?.category || 'OTHER';
  const { data: template } = await supabase
    .from('b2b_reminder_templates')
    .select('*')
    .eq('category', businessCategory)
    .single();

  log.info('Triggering reminder call', {
    appointmentId: id,
    customer: appointment.customer?.name,
    phone: customerPhone,
    scheduledAt: appointment.scheduled_at,
    category: businessCategory,
    hasTemplate: !!template,
  });

  // Use LiveKit (Gemini voice) if available
  if (livekitEnabled && sipClient && agentDispatch) {
    try {
      const roomName = `reminder-${id}-${Date.now()}`;
      
      // Prepare metadata with appointment and template data
      const metadata = JSON.stringify({
        call_type: 'reminder',
        voice_preference: appointment.business?.voice_preference || 'Kore',
        appointment: {
          id: appointment.id,
          title: appointment.title,
          scheduled_at: appointment.scheduled_at,
          customer_name: appointment.customer?.name,
          business_name: appointment.business?.name,
          business_category: businessCategory,
          business_timezone: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles',
        },
        template: template ? {
          category: template.category,
          system_prompt: template.system_prompt,
          greeting: template.greeting,
          confirmation_ask: template.confirmation_ask,
          reschedule_ask: template.reschedule_ask,
          closing: template.closing,
          voicemail: template.voicemail,
        } : null,
      });

      // Dispatch agent to room
      await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
        metadata: metadata,
      });

      // Create outbound SIP call
      const sipCall = await sipClient.createSipParticipant(
        config.livekitSipTrunkId,
        customerPhone,
        roomName,
        {
          participantIdentity: `customer-${appointment.customer_id}`,
          participantName: appointment.customer?.name || 'Customer',
          playDialtone: false,
        }
      );

      log.info('LiveKit reminder call created', { roomName, sipCallId: sipCall.sipCallId });

      // Update appointment status
      await supabase
        .from('b2b_appointments')
        .update({ status: 'REMINDED' })
        .eq('id', id);

      // Log the call
      await supabase.from('b2b_call_logs').insert({
        appointment_id: id,
        customer_id: appointment.customer_id,
        business_id: appointment.business_id,
        call_type: 'REMINDER',
        room_name: roomName,
        sip_call_id: sipCall.sipCallId,
      });

      return res.json({ 
        success: true, 
        message: 'Call initiated via Gemini AI',
        room_name: roomName,
        sip_call_id: sipCall.sipCallId,
        template_used: template?.category || null,
      });
    } catch (error) {
      log.error('LiveKit call failed, falling back to Telnyx', error);
    }
  }

  // Fallback: Create call via Telnyx (basic TTS)
  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: customerPhone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/call-events`,
    webhook_url_method: 'POST',
    custom_headers: [
      { name: 'X-Appointment-Id', value: id },
      { name: 'X-Customer-Name', value: appointment.customer?.name || 'Customer' },
      { name: 'X-Appointment-Title', value: appointment.title },
      { name: 'X-Appointment-Time', value: appointment.scheduled_at },
      { name: 'X-Business-Name', value: appointment.business?.name || 'Our office' },
      { name: 'X-Business-Category', value: businessCategory },
      { name: 'X-Business-Timezone', value: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles' },
    ],
  });

  log.info('Telnyx call created', { callId: call.data?.call_control_id });

  // Update appointment status
  await supabase
    .from('b2b_appointments')
    .update({ status: 'REMINDED' })
    .eq('id', id);

  // Log the call
  await supabase.from('b2b_call_logs').insert({
    appointment_id: id,
    customer_id: appointment.customer_id,
    business_id: appointment.business_id,
    call_type: 'REMINDER',
    sip_call_id: call.data?.call_control_id,
  });

  res.json({ 
    success: true, 
    message: 'Call initiated (basic TTS)',
    call_id: call.data?.call_control_id,
  });
}));

// Webhook endpoint for Telnyx call events
app.post('/api/webhooks/telnyx/call-events', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;
  
  log.debug('Telnyx webhook received', { eventType, callControlId });

  // Extract custom headers
  const getHeader = (name: string) => 
    event.data?.payload?.custom_headers?.find((h: any) => h.name === name)?.value;

  const appointmentId = getHeader('X-Appointment-Id');
  const customerName = getHeader('X-Customer-Name') || 'there';
  const appointmentTitle = getHeader('X-Appointment-Title') || 'your appointment';
  const appointmentTime = getHeader('X-Appointment-Time');
  const businessName = getHeader('X-Business-Name') || 'our office';
  const businessTimezone = getHeader('X-Business-Timezone');

  switch (eventType) {
    case 'call.initiated':
      log.info('Call initiated', { callControlId });
      break;

    case 'call.answered':
      log.info('Call answered', { callControlId });
      
      // Update call log
      await supabase
        .from('b2b_call_logs')
        .update({ call_outcome: 'ANSWERED' })
        .eq('sip_call_id', callControlId);
      
      // Format the appointment time in business timezone
      const formattedTime = appointmentTime
        ? new Date(appointmentTime).toLocaleString('en-US', {
            timeZone: businessTimezone || 'America/Los_Angeles',
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'soon';

      // Speak the reminder message
      await telnyx.calls.actions.speak(callControlId, {
        payload: `Hello ${customerName}! This is a friendly reminder from ${businessName} about ${appointmentTitle} scheduled for ${formattedTime}. Press 1 to confirm your appointment, or press 2 if you need to reschedule. Thank you!`,
        voice: 'female',
        language: 'en-US',
      });
      break;

    case 'call.speak.ended':
      // Gather DTMF input after speaking
      await telnyx.calls.actions.gather(callControlId, {
        minimum_digits: 1,
        maximum_digits: 1,
        timeout_millis: 10000,
      });
      break;

    case 'call.gather.ended':
      const digits = event.data?.payload?.digits;
      log.info('DTMF received', { callControlId, digits });
      
      if (digits === '1') {
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Great! Your appointment is confirmed. We look forward to seeing you. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
        
        if (appointmentId) {
          await supabase
            .from('b2b_appointments')
            .update({ status: 'CONFIRMED' })
            .eq('id', appointmentId);
            
          await supabase
            .from('b2b_call_logs')
            .update({ call_outcome: 'CONFIRMED' })
            .eq('sip_call_id', callControlId);
        }
      } else if (digits === '2') {
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'No problem. Please contact us to reschedule your appointment. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
        
        if (appointmentId) {
          await supabase
            .from('b2b_appointments')
            .update({ status: 'RESCHEDULED' })
            .eq('id', appointmentId);
            
          await supabase
            .from('b2b_call_logs')
            .update({ call_outcome: 'RESCHEDULED' })
            .eq('sip_call_id', callControlId);
        }
      } else {
        // No input or invalid input - thank them anyway
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Thank you for your time. If you have questions, please contact us. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
      }
      
      // Hang up after response
      setTimeout(async () => {
        try {
          await telnyx.calls.actions.hangup(callControlId, {});
        } catch (e) {
          log.debug('Call may have already ended');
        }
      }, 5000);
      break;

    case 'call.hangup':
      const duration = event.data?.payload?.duration_secs;
      log.info('Call ended', { callControlId, duration });
      
      await supabase
        .from('b2b_call_logs')
        .update({ duration_sec: duration })
        .eq('sip_call_id', callControlId);
      break;

    case 'call.machine.detection.ended':
      const result = event.data?.payload?.result;
      if (result === 'machine') {
        log.info('Voicemail detected', { callControlId });
        
        await supabase
          .from('b2b_call_logs')
          .update({ call_outcome: 'VOICEMAIL' })
          .eq('sip_call_id', callControlId);
        
        await telnyx.calls.actions.speak(callControlId, {
          payload: `Hello, this is a reminder from ${businessName} about your upcoming appointment for ${appointmentTitle}. Please call us back to confirm. Thank you!`,
          voice: 'female',
          language: 'en-US',
        });
      }
      break;
  }

  res.json({ received: true });
}));

// Get call logs for a business
app.get('/api/call-logs', authenticateUser, verifyBusinessOwnership, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { business_id, limit = '50' } = req.query;

  // Use authenticated user's business_id if not provided
  const targetBusinessId = business_id as string || req.user?.business_id;

  if (!targetBusinessId) {
    return res.status(400).json({ error: 'business_id query parameter is required' });
  }

  // Validate business_id format
  if (!isValidUUID(targetBusinessId)) {
    return res.status(400).json({ error: 'Invalid business_id format' });
  }

  // Validate and sanitize limit
  const parsedLimit = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);

  const { data: logs, error } = await supabase
    .from('b2b_call_logs')
    .select(`
      *,
      customer:b2b_customers(name, phone),
      appointment:b2b_appointments(title, scheduled_at, status)
    `)
    .eq('business_id', targetBusinessId)
    .order('created_at', { ascending: false })
    .limit(parsedLimit);

  if (error) {
    log.error('Failed to fetch call logs', error);
    throw error;
  }

  res.json({ logs, count: logs?.length || 0 });
}));

// Get a single call log with full transcript
app.get('/api/calls/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  // Validate call ID format
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid call ID format' });
  }

  const { data: call, error } = await supabase
    .from('b2b_call_logs')
    .select(`
      *,
      customer:b2b_customers(name, phone, email),
      appointment:b2b_appointments(title, scheduled_at, status, description)
    `)
    .eq('id', id)
    .single();

  if (error) {
    log.error('Failed to fetch call', error);
    throw error;
  }
  
  if (!call) {
    return res.status(404).json({ error: 'Call not found' });
  }

  // Verify ownership - check if call belongs to user's business
  if (req.user?.business_id && call.business_id !== req.user.business_id) {
    return res.status(403).json({ error: 'Access denied to this call' });
  }

  res.json({ call });
}));

// Find call log by room name (used by agent to get call_log_id)
app.get('/api/calls/by-room/:roomName', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { roomName } = req.params;

  const { data: call, error } = await supabase
    .from('b2b_call_logs')
    .select('*')
    .eq('room_name', roomName)
    .single();

  if (error && error.code !== 'PGRST116') {
    log.error('Failed to find call by room', error);
    throw error;
  }
  
  if (!call) {
    return res.status(404).json({ error: 'Call not found for this room' });
  }

  res.json({ call });
}));

// ==========================================
// AGENT CALLBACK ENDPOINTS
// Called by the LiveKit agent during/after calls
// ==========================================

// Update appointment status (called by agent on confirm/cancel)
app.patch('/api/appointments/:id/status', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, notes, call_log_id } = req.body;

  // Validate appointment ID format
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid appointment ID format' });
  }

  // Validate status
  const validStatuses = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'COMPLETED', 'NO_SHOW'];
  if (!validStatuses.includes(status?.toUpperCase())) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  log.info('Updating appointment status', { id, status, call_log_id });

  // Update appointment
  const { data: appointment, error: updateError } = await supabase
    .from('b2b_appointments')
    .update({ 
      status: status.toUpperCase(),
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    log.error('Failed to update appointment status', updateError);
    throw updateError;
  }

  // If call_log_id provided, update the call outcome too
  if (call_log_id) {
    const callOutcome = status.toUpperCase() === 'CONFIRMED' ? 'CONFIRMED' 
      : status.toUpperCase() === 'CANCELED' ? 'CANCELED'
      : status.toUpperCase() === 'RESCHEDULED' ? 'RESCHEDULED'
      : 'ANSWERED';

    await supabase
      .from('b2b_call_logs')
      .update({ 
        call_outcome: callOutcome,
        summary: notes || null
      })
      .eq('id', call_log_id);
  }

  res.json({ success: true, appointment });
}));

// Request reschedule (called by agent when customer wants to reschedule)
app.post('/api/appointments/:id/reschedule', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { preferred_time, reason, call_log_id } = req.body;

  // Validate appointment ID format
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid appointment ID format' });
  }

  log.info('Reschedule requested', { id, preferred_time, reason, call_log_id });

  // Get existing description to append to
  const { data: existing } = await supabase
    .from('b2b_appointments')
    .select('description')
    .eq('id', id)
    .single();

  const rescheduleNote = `[RESCHEDULE REQUESTED] Preferred time: ${preferred_time}. Reason: ${reason || 'Not specified'}`;
  const newDescription = existing?.description 
    ? `${existing.description}\n\n${rescheduleNote}`
    : rescheduleNote;

  // Update appointment status to RESCHEDULED and add notes
  const { data: appointment, error: updateError } = await supabase
    .from('b2b_appointments')
    .update({ 
      status: 'RESCHEDULED',
      description: newDescription,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (updateError) {
    log.error('Failed to process reschedule', updateError);
    throw updateError;
  }

  // Update call log if provided
  if (call_log_id) {
    await supabase
      .from('b2b_call_logs')
      .update({ 
        call_outcome: 'RESCHEDULED',
        summary: `Customer requested to reschedule. Preferred time: ${preferred_time}. Reason: ${reason || 'Not specified'}`
      })
      .eq('id', call_log_id);
  }

  res.json({ success: true, appointment });
}));

// Save call transcript (called by agent at end of call)
app.post('/api/calls/:id/transcript', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { transcript, summary, duration_sec, call_outcome } = req.body;

  // Validate call ID format
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid call ID format' });
  }

  log.info('Saving transcript', { id, duration_sec, call_outcome });

  // Attempt Gemini AI analysis of the transcript
  const geminiResult = await analyzeTranscriptWithGemini(transcript);

  // Use Gemini results if available, otherwise fall back to agent-provided values
  const finalSummary = geminiResult?.summary || summary || null;
  const finalOutcome = geminiResult?.call_outcome || (call_outcome ? call_outcome.toUpperCase() : null);

  if (geminiResult) {
    log.info('Using Gemini AI summary', { id, outcome: finalOutcome });
  } else {
    log.info('Using agent-provided summary', { id, outcome: finalOutcome });
  }

  const updateData: any = {
    transcript: transcript || null,
    summary: finalSummary,
  };

  if (duration_sec !== undefined) {
    updateData.duration_sec = duration_sec;
  }

  if (finalOutcome) {
    updateData.call_outcome = finalOutcome;
  }

  const { data: call, error } = await supabase
    .from('b2b_call_logs')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    log.error('Failed to save transcript', error);
    throw error;
  }

  res.json({ success: true, call });
}));

// Manual test call endpoint (uses basic TTS)
app.post('/api/test-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { phone, message, voice_preference, business_name, business_id, business_category } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  // Validate phone number format
  if (!isValidPhoneNumber(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  // Validate business_id if provided
  if (business_id && !isValidUUID(business_id)) {
    return res.status(400).json({ error: 'Invalid business_id format' });
  }

  log.info('Making test call', { phone, livekitEnabled, business_category });

  // Fetch template if category provided
  let template = null;
  if (business_category || business_id) {
    let category = business_category;
    
    // If business_id provided, fetch the business to get category
    if (business_id && !category) {
      const { data: business } = await supabase
        .from('b2b_businesses')
        .select('category')
        .eq('id', business_id)
        .single();
      category = business?.category || 'OTHER';
    }
    
    // Fetch template for this category
    const { data: templateData } = await supabase
      .from('b2b_reminder_templates')
      .select('*')
      .eq('category', category || 'OTHER')
      .single();
    
    template = templateData;
    log.info('Using template for category', { category, hasTemplate: !!template });
  }

  // Use LiveKit if configured (Gemini voice), otherwise fall back to Telnyx TTS
  if (livekitEnabled && sipClient && agentDispatch) {
    try {
      // Create a unique room for this call
      const roomName = `test-call-${Date.now()}`;
      
      // Prepare metadata for the agent (include template if available)
      const metadata = JSON.stringify({
        call_type: 'test',
        voice_preference: voice_preference || 'Kore',
        family_name: business_name || 'Nemo B2B',
        recipient_preferred_name: 'there',
        greeting_message: message || 'Hello! This is a test call from Nemo. How do I sound?',
        template: template ? {
          category: template.category,
          system_prompt: template.system_prompt,
          greeting: template.greeting,
          confirmation_ask: template.confirmation_ask,
          reschedule_ask: template.reschedule_ask,
          closing: template.closing,
          voicemail: template.voicemail,
        } : null,
      });

      // First, dispatch the agent to the room so it's ready when the call connects
      log.info('Dispatching agent to room', { roomName, agentName: config.livekitAgentName });
      await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
        metadata: metadata,
      });

      // Create outbound SIP call via LiveKit
      const sipCall = await sipClient.createSipParticipant(
        config.livekitSipTrunkId,
        phone,
        roomName,
        {
          participantIdentity: `caller-${Date.now()}`,
          participantName: 'Test Call Recipient',
          playDialtone: false,
        }
      );

      log.info('LiveKit SIP call created', { roomName, sipCallId: sipCall.sipCallId });

      return res.json({ 
        success: true, 
        message: 'Test call initiated via Gemini AI',
        room_name: roomName,
        sip_call_id: sipCall.sipCallId,
        voice: voice_preference || 'Kore',
      });
    } catch (error: any) {
      log.error('LiveKit call failed, falling back to Telnyx', error);
      // Fall through to Telnyx
    }
  }
  
  // Fallback: Use Telnyx with basic TTS
  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: phone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/test-call`,
    webhook_url_method: 'POST',
  });

  res.json({ 
    success: true, 
    message: 'Test call initiated (basic TTS)',
    call_id: call.data?.call_control_id 
  });
}));

// Test call webhook (basic TTS)
app.post('/api/webhooks/telnyx/test-call', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;

  if (eventType === 'call.answered') {
    await telnyx.calls.actions.speak(callControlId, {
      payload: 'Hello! This is a test call from Nemo B2B. Your appointment reminder system is working correctly. Goodbye!',
      voice: 'female',
      language: 'en-US',
    });
  } else if (eventType === 'call.speak.ended') {
    await telnyx.calls.actions.hangup(callControlId, {});
  }

  res.json({ received: true });
}));

// ============================================
// GEMINI LIVE AI CALL ENDPOINTS
// ============================================

// AI test call endpoint - uses Gemini Live for natural conversation
app.post('/api/ai-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { phone, systemPrompt } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  if (!googleAI) {
    return res.status(503).json({ error: 'Gemini Live not configured' });
  }

  // Validate phone number format
  if (!isValidPhoneNumber(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  const defaultPrompt = `You are Nemo, a friendly and helpful AI assistant making a phone call. 
You work for an appointment reminder service. Be warm, conversational, and natural.
Keep responses concise since this is a phone call. 
If the user asks about their appointment, explain you're calling to remind them about their upcoming appointment.
If they want to confirm, thank them warmly. If they want to reschedule, be understanding and helpful.`;

  log.info('Making AI call with Gemini Live', { phone });

  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: phone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/ai-call`,
    webhook_url_method: 'POST',
    custom_headers: [
      { name: 'X-System-Prompt', value: Buffer.from(systemPrompt || defaultPrompt).toString('base64') },
    ],
  });

  res.json({ 
    success: true, 
    message: 'AI call initiated with Gemini Live',
    call_id: call.data?.call_control_id 
  });
}));

// AI call webhook - handles Gemini Live streaming
app.post('/api/webhooks/telnyx/ai-call', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;

  log.debug('AI call webhook received', { eventType, callControlId });

  const getHeader = (name: string) => 
    event.data?.payload?.custom_headers?.find((h: any) => h.name === name)?.value;

  switch (eventType) {
    case 'call.initiated':
      log.info('AI call initiated', { callControlId });
      break;

    case 'call.answered':
      log.info('AI call answered', { callControlId });
      
      // Get system prompt from headers
      const encodedPrompt = getHeader('X-System-Prompt');
      const systemPrompt = encodedPrompt 
        ? Buffer.from(encodedPrompt, 'base64').toString('utf-8')
        : 'You are Nemo, a friendly AI assistant. Be helpful and concise.';

      // Create Gemini Live session
      const session = await createGeminiLiveSession(callControlId, systemPrompt);
      
      if (!session) {
        log.error('Failed to create Gemini session, falling back to TTS');
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Hello! I apologize, but I am having trouble connecting. Please try again later. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
        return res.json({ received: true });
      }

      // Start bidirectional audio streaming with Telnyx
      // The stream_url should point to our WebSocket server
      try {
        // Use type assertion since SDK types may not include all methods
        await (telnyx.calls.actions as any).streamingStart(callControlId, {
          stream_url: `${config.wsUrl}/media-stream?call_control_id=${callControlId}`,
          stream_track: 'both_tracks',
        });
        log.info('Started Telnyx media streaming', { callControlId });
        
        // Send initial greeting via Gemini
        await session.liveSession.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{ text: 'The call has just started. Please greet the caller warmly and introduce yourself.' }],
          }],
          turnComplete: true,
        });
      } catch (streamError) {
        log.error('Failed to start media streaming', streamError);
        // Fallback to basic TTS if streaming fails
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Hello! This is Nemo, your AI assistant. How can I help you today?',
          voice: 'female',
          language: 'en-US',
        });
      }
      break;

    case 'call.streaming.started':
      log.info('Media streaming started', { callControlId });
      break;

    case 'call.streaming.stopped':
      log.info('Media streaming stopped', { callControlId });
      break;

    case 'call.hangup':
      log.info('AI call ended', { callControlId });
      await closeGeminiSession(callControlId);
      break;

    case 'call.speak.ended':
      // If we fell back to TTS, hang up after speaking
      const session2 = geminiSessions.get(callControlId);
      if (!session2) {
        await telnyx.calls.actions.hangup(callControlId, {});
      }
      break;
  }

  res.json({ received: true });
}));

// ============================================
// TEMPLATE ENDPOINTS
// ============================================

// Get all available templates (for admin/debugging)
app.get('/api/templates', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data: templates, error } = await supabase
    .from('b2b_reminder_templates')
    .select('*')
    .order('category_label');

  if (error) {
    log.error('Failed to fetch templates', error);
    throw error;
  }

  res.json({ templates, count: templates?.length || 0 });
}));

// Get template by category
app.get('/api/templates/:category', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const category = req.params.category as string;
  
  const { data: template, error } = await supabase
    .from('b2b_reminder_templates')
    .select('*')
    .eq('category', category.toUpperCase())
    .single();

  if (error || !template) {
    // Fall back to OTHER template
    const { data: fallback } = await supabase
      .from('b2b_reminder_templates')
      .select('*')
      .eq('category', 'OTHER')
      .single();
    
    if (fallback) {
      return res.json({ template: fallback });
    }
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json({ template });
}));

// Get business categories list (for signup dropdown)
app.get('/api/business-categories', (req: Request, res: Response) => {
  const categories = [
    { value: 'BARBERSHOP', label: 'Barbershop', icon: '💈' },
    { value: 'SALON', label: 'Hair Salon', icon: '💇' },
    { value: 'DENTAL', label: 'Dental Office', icon: '🦷' },
    { value: 'MEDICAL', label: 'Medical Clinic', icon: '🏥' },
    { value: 'AUTO_REPAIR', label: 'Auto Repair Shop', icon: '🚗' },
    { value: 'PET_GROOMING', label: 'Pet Grooming', icon: '🐕' },
    { value: 'SPA', label: 'Spa & Wellness', icon: '💆' },
    { value: 'FITNESS', label: 'Fitness & Training', icon: '💪' },
    { value: 'TUTORING', label: 'Tutoring & Education', icon: '📚' },
    { value: 'OTHER', label: 'Other', icon: '🏢' },
  ];
  res.json({ categories });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ============================================
// REMINDER SCHEDULER
// ============================================

const SCHEDULER_INTERVAL_MS = 60 * 1000; // Check every minute
let schedulerRunning = false;
const INSTANCE_ID = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function checkAndTriggerReminders() {
  if (schedulerRunning) {
    log.debug('Scheduler already running, skipping...');
    return;
  }
  
  schedulerRunning = true;
  log.info(`Scheduler: Checking for pending reminders... (instance: ${INSTANCE_ID})`);
  
  try {
    const now = new Date();
    
    // Fetch appointments that need reminders
    // Include appointments up to 1 hour in the past (in case scheduler missed them)
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const { data: appointments, error } = await supabase
      .from('b2b_appointments')
      .select(`
        *,
        customer:b2b_customers(*),
        business:b2b_businesses(*)
      `)
      .eq('status', 'SCHEDULED')
      .lte('scheduled_at', new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString())
      .gte('scheduled_at', oneHourAgo.toISOString());

    if (error) {
      log.error('Scheduler: Failed to fetch appointments', error);
      return;
    }

    // Filter to those that need reminders now
    const pendingReminders = appointments?.filter(apt => {
      const scheduledAt = new Date(apt.scheduled_at);
      const reminderMinutes = apt.reminder_minutes_before ?? 30;
      const reminderTime = new Date(scheduledAt.getTime() - reminderMinutes * 60 * 1000);
      return reminderTime <= now;
    }) || [];

    if (pendingReminders.length === 0) {
      log.info('Scheduler: No pending reminders');
      return;
    }

    log.info(`Scheduler: Found ${pendingReminders.length} appointments needing reminders`);

    // Trigger calls for each appointment
    for (const appointment of pendingReminders) {
      try {
        const customerPhone = appointment.customer?.phone;
        if (!customerPhone) {
          log.error(`Scheduler: No phone for appointment ${appointment.id}`);
          continue;
        }

        // Validate phone number
        if (!customerPhone.match(/^\+?[1-9]\d{1,14}$/)) {
          log.error(`Scheduler: Invalid phone for appointment ${appointment.id}: ${customerPhone}`);
          continue;
        }

        // ATOMICALLY claim this appointment to prevent duplicate calls from multiple instances
        // Only update if status is still SCHEDULED (prevents race condition)
        const { data: claimedRows, error: claimError } = await supabase
          .from('b2b_appointments')
          .update({ status: 'REMINDED', updated_at: new Date().toISOString() })
          .eq('id', appointment.id)
          .eq('status', 'SCHEDULED')  // Only if still SCHEDULED
          .select();

        // If no rows updated, appointment was already claimed by another instance
        if (claimError) {
          log.error(`Scheduler: Error claiming appointment ${appointment.id}`, claimError);
          continue;
        }
        
        if (!claimedRows || claimedRows.length === 0) {
          log.info(`Scheduler: Appointment ${appointment.id} already claimed by another instance, skipping`);
          continue;
        }
        
        const claimed = claimedRows[0];

        log.info(`Scheduler: Triggering call for appointment ${appointment.id}`, {
          customer: appointment.customer?.name,
          phone: customerPhone,
          scheduledAt: appointment.scheduled_at,
        });

        // Fetch template for business category
        const businessCategory = appointment.business?.category || 'OTHER';
        const { data: template } = await supabase
          .from('b2b_reminder_templates')
          .select('*')
          .eq('category', businessCategory)
          .single();

        // Use LiveKit if available
        if (livekitEnabled && sipClient && agentDispatch) {
          const roomName = `reminder-${appointment.id}-${Date.now()}`;
          
          const metadata = JSON.stringify({
            call_type: 'reminder',
            voice_preference: appointment.business?.voice_preference || 'Kore',
            appointment: {
              id: appointment.id,
              title: appointment.title,
              scheduled_at: appointment.scheduled_at,
              customer_name: appointment.customer?.name,
              business_name: appointment.business?.name,
              business_category: businessCategory,
              business_timezone: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles',
            },
            template: template ? {
              category: template.category,
              system_prompt: template.system_prompt,
              greeting: template.greeting,
              confirmation_ask: template.confirmation_ask,
              reschedule_ask: template.reschedule_ask,
              closing: template.closing,
              voicemail: template.voicemail,
            } : null,
          });

          await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
            metadata: metadata,
          });

          const sipCall = await sipClient.createSipParticipant(
            config.livekitSipTrunkId,
            customerPhone,
            roomName,
            {
              participantIdentity: `customer-${appointment.customer_id}`,
              participantName: appointment.customer?.name || 'Customer',
              playDialtone: false,
            }
          );

          log.info(`Scheduler: LiveKit call created for ${appointment.id}`, { roomName, sipCallId: sipCall.sipCallId });

          // Log the call
          await supabase.from('b2b_call_logs').insert({
            appointment_id: appointment.id,
            customer_id: appointment.customer_id,
            business_id: appointment.business_id,
            call_type: 'REMINDER',
            room_name: roomName,
            sip_call_id: sipCall.sipCallId,
          });

        } else {
          // Fallback to Telnyx
          const call = await telnyx.calls.dial({
            connection_id: config.telnyxConnectionId,
            to: customerPhone,
            from: config.telnyxPhoneNumber,
            webhook_url: `${config.apiUrl}/api/webhooks/telnyx/call-events`,
            webhook_url_method: 'POST',
            custom_headers: [
              { name: 'X-Appointment-Id', value: appointment.id },
              { name: 'X-Customer-Name', value: appointment.customer?.name || 'Customer' },
              { name: 'X-Appointment-Title', value: appointment.title },
              { name: 'X-Appointment-Time', value: appointment.scheduled_at },
              { name: 'X-Business-Name', value: appointment.business?.name || 'Our office' },
              { name: 'X-Business-Category', value: businessCategory },
              { name: 'X-Business-Timezone', value: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles' },
            ],
          });

          log.info(`Scheduler: Telnyx call created for ${appointment.id}`, { callId: call.data?.call_control_id });

          // Note: Status already updated to REMINDED above (atomic claim)

          await supabase.from('b2b_call_logs').insert({
            appointment_id: appointment.id,
            customer_id: appointment.customer_id,
            business_id: appointment.business_id,
            call_type: 'REMINDER',
            sip_call_id: call.data?.call_control_id,
          });
        }

      } catch (callError) {
        log.error(`Scheduler: Failed to trigger call for appointment ${appointment.id}`, callError);
        // If call failed, revert status back to SCHEDULED so it can be retried
        await supabase
          .from('b2b_appointments')
          .update({ status: 'SCHEDULED' })
          .eq('id', appointment.id);
      }
    }

  } catch (err) {
    log.error('Scheduler: Unexpected error', err);
  } finally {
    schedulerRunning = false;
  }
}

// Start the scheduler
function startReminderScheduler() {
  log.info('Starting reminder scheduler (interval: 60s)');
  
  // Run immediately on startup
  setTimeout(() => checkAndTriggerReminders(), 5000);
  
  // Then run every minute
  setInterval(checkAndTriggerReminders, SCHEDULER_INTERVAL_MS);
}

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
  console.log('');
  
  // Start the reminder scheduler
  startReminderScheduler();
});

export default app;
