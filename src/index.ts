import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Telnyx from 'telnyx';
import dotenv from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { GoogleGenAI, Modality } from '@google/genai';
import { SipClient, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';

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
  googleAiApiKey: process.env.GOOGLE_AI_API_KEY,
  nodeEnv: process.env.NODE_ENV || 'development',
  // LiveKit config (optional - for Gemini voice)
  livekitUrl: process.env.LIVEKIT_URL || '',
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitSipTrunkId: process.env.SIP_TRUNK_ID || '',
  livekitAgentName: process.env.LIVEKIT_AGENT_NAME || 'nemo_b2b_agent',
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
// EXPRESS APP
// ============================================

const app = express();
const server = createServer(app);

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

// Middleware
app.use(cors());
app.use(express.json());

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
  log.error('Unhandled error', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: config.nodeEnv === 'development' ? err.message : undefined
  });
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

// Get upcoming appointments that need reminders
app.get('/api/appointments/pending-reminders', asyncHandler(async (req: Request, res: Response) => {
  const now = new Date();
  
  const { data: appointments, error } = await supabase
    .from('b2b_appointments')
    .select(`
      *,
      customer:b2b_customers(*),
      business:b2b_businesses(*)
    `)
    .eq('status', 'SCHEDULED')
    .eq('reminder_enabled', true)
    .lte('scheduled_at', new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());

  if (error) {
    log.error('Failed to fetch appointments', error);
    throw error;
  }

  // Filter to only those that need reminders now
  const pendingReminders = appointments?.filter(apt => {
    const scheduledAt = new Date(apt.scheduled_at);
    const reminderHours = apt.reminder_hours || 24;
    const reminderTime = new Date(scheduledAt.getTime() - reminderHours * 60 * 60 * 1000);
    return reminderTime <= now;
  }) || [];

  log.info(`Found ${pendingReminders.length} pending reminders`);
  res.json({ appointments: pendingReminders, count: pendingReminders.length });
}));

// Trigger a reminder call for an appointment
app.post('/api/appointments/:id/trigger-call', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  
  // Get appointment details
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

  log.info('Triggering reminder call', {
    appointmentId: id,
    customer: appointment.customer?.name,
    phone: customerPhone,
    scheduledAt: appointment.scheduled_at
  });

  // Create call via Telnyx
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
    message: 'Call initiated',
    call_id: call.data?.call_control_id,
  });
}));

// Webhook endpoint for Telnyx call events
app.post('/api/webhooks/telnyx/call-events', asyncHandler(async (req: Request, res: Response) => {
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
      
      // Format the appointment time nicely
      const formattedTime = appointmentTime 
        ? new Date(appointmentTime).toLocaleString('en-US', {
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
app.get('/api/call-logs', asyncHandler(async (req: Request, res: Response) => {
  const { business_id, limit = '50' } = req.query;
  
  if (!business_id) {
    return res.status(400).json({ error: 'business_id query parameter is required' });
  }

  const { data: logs, error } = await supabase
    .from('b2b_call_logs')
    .select(`
      *,
      customer:b2b_customers(name, phone),
      appointment:b2b_appointments(title, scheduled_at)
    `)
    .eq('business_id', business_id)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit as string));

  if (error) {
    log.error('Failed to fetch call logs', error);
    throw error;
  }

  res.json({ logs, count: logs?.length || 0 });
}));

// Manual test call endpoint (uses basic TTS)
app.post('/api/test-call', asyncHandler(async (req: Request, res: Response) => {
  const { phone, message, voice_preference, business_name } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  // Validate phone number format
  if (!phone.match(/^\+?[1-9]\d{1,14}$/)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  log.info('Making test call', { phone, livekitEnabled });

  // Use LiveKit if configured (Gemini voice), otherwise fall back to Telnyx TTS
  if (livekitEnabled && sipClient && agentDispatch) {
    try {
      // Create a unique room for this call
      const roomName = `test-call-${Date.now()}`;
      
      // Prepare metadata for the agent
      const metadata = JSON.stringify({
        call_type: 'test',
        voice_preference: voice_preference || 'Puck',
        family_name: business_name || 'Nemo B2B',
        recipient_preferred_name: 'there',
        greeting_message: message || 'Hello! This is a test call from Nemo. How do I sound?',
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
        voice: voice_preference || 'Puck',
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
app.post('/api/webhooks/telnyx/test-call', asyncHandler(async (req: Request, res: Response) => {
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
app.post('/api/ai-call', asyncHandler(async (req: Request, res: Response) => {
  const { phone, systemPrompt } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  if (!googleAI) {
    return res.status(503).json({ error: 'Gemini Live not configured - missing GOOGLE_AI_API_KEY' });
  }

  // Validate phone number format
  if (!phone.match(/^\+?[1-9]\d{1,14}$/)) {
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
app.post('/api/webhooks/telnyx/ai-call', asyncHandler(async (req: Request, res: Response) => {
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

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
});

export default app;
