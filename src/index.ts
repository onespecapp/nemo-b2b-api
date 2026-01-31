import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Telnyx from 'telnyx';
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

const config = {
  port: parseInt(process.env.PORT || '6001'),
  apiUrl: process.env.API_URL || `http://localhost:${process.env.PORT || 6001}`,
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  telnyxApiKey: process.env.TELNYX_API_KEY!,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID!,
  telnyxPhoneNumber: process.env.TELNYX_PHONE_NUMBER!,
  nodeEnv: process.env.NODE_ENV || 'development',
};

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

// ============================================
// EXPRESS APP
// ============================================

const app = express();

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
    version: '1.0.0',
    environment: config.nodeEnv,
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
      
    case 'call.hangup':
      // Call ended without answer
      if (!event.data?.payload?.hangup_cause?.includes('NORMAL')) {
        await supabase
          .from('b2b_call_logs')
          .update({ call_outcome: 'NO_ANSWER' })
          .eq('sip_call_id', callControlId);
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

// Manual test call endpoint
app.post('/api/test-call', asyncHandler(async (req: Request, res: Response) => {
  const { phone, message } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  // Validate phone number format
  if (!phone.match(/^\+?[1-9]\d{1,14}$/)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  log.info('Making test call', { phone });

  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: phone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/test-call`,
    webhook_url_method: 'POST',
  });

  res.json({ 
    success: true, 
    message: 'Test call initiated',
    call_id: call.data?.call_control_id 
  });
}));

// Test call webhook
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ============================================
// START SERVER
// ============================================

app.listen(config.port, () => {
  console.log('');
  console.log('🚀 Nemo B2B API Started');
  console.log('========================');
  console.log(`📍 Port: ${config.port}`);
  console.log(`🌍 Environment: ${config.nodeEnv}`);
  console.log(`📞 Telnyx Phone: ${config.telnyxPhoneNumber}`);
  console.log(`🔗 Webhook URL: ${config.apiUrl}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /api/appointments/pending-reminders');
  console.log('  POST /api/appointments/:id/trigger-call');
  console.log('  GET  /api/call-logs?business_id=xxx');
  console.log('  POST /api/test-call');
  console.log('');
});

export default app;
