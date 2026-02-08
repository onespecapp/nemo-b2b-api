import dotenv from 'dotenv';

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

export const config = {
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

// ============================================
// LOGGING UTILITY
// ============================================

export const log = {
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
