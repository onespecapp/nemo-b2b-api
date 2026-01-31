import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Telnyx from 'telnyx';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Telnyx client
const telnyx = new Telnyx({
  apiKey: process.env.TELNYX_API_KEY!,
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nemo-b2b-api' });
});

// Get upcoming appointments that need reminders
app.get('/api/appointments/pending-reminders', async (req, res) => {
  try {
    const now = new Date();
    
    const { data: appointments, error } = await supabase
      .from('b2b_appointments')
      .select(`
        *,
        customer:b2b_customers(*),
        business:b2b_businesses(*)
      `)
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());

    if (error) throw error;

    // Filter to only those that need reminders now
    const pendingReminders = appointments?.filter(apt => {
      const scheduledAt = new Date(apt.scheduled_at);
      const reminderTime = new Date(scheduledAt.getTime() - apt.reminder_minutes_before * 60 * 1000);
      return reminderTime <= now;
    }) || [];

    res.json({ appointments: pendingReminders });
  } catch (error) {
    console.error('Error fetching pending reminders:', error);
    res.status(500).json({ error: 'Failed to fetch pending reminders' });
  }
});

// Trigger a reminder call for an appointment
app.post('/api/appointments/:id/trigger-call', async (req, res) => {
  try {
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
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const customerPhone = appointment.customer?.phone;
    if (!customerPhone) {
      return res.status(400).json({ error: 'Customer has no phone number' });
    }

    console.log(`Triggering call for appointment ${id}`);
    console.log(`Customer: ${appointment.customer?.name} (${customerPhone})`);
    console.log(`Appointment: ${appointment.title} at ${appointment.scheduled_at}`);

    // Create call via Telnyx
    const call = await telnyx.calls.dial({
      connection_id: process.env.TELNYX_CONNECTION_ID!,
      to: customerPhone,
      from: process.env.TELNYX_PHONE_NUMBER!,
      webhook_url: `${process.env.API_URL || 'http://localhost:6001'}/api/webhooks/telnyx/call-events`,
      webhook_url_method: 'POST',
      custom_headers: [
        { name: 'X-Appointment-Id', value: id },
        { name: 'X-Customer-Name', value: appointment.customer?.name || 'Customer' },
        { name: 'X-Appointment-Title', value: appointment.title },
        { name: 'X-Appointment-Time', value: appointment.scheduled_at },
      ],
    });

    console.log('Telnyx call created:', call.data);

    // Update appointment status
    const { error: updateError } = await supabase
      .from('b2b_appointments')
      .update({ 
        status: 'reminded',
        call_attempts: (appointment.call_attempts || 0) + 1,
        last_call_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) console.error('Error updating appointment:', updateError);

    // Log the call
    await supabase.from('b2b_call_logs').insert({
      appointment_id: id,
      customer_id: appointment.customer_id,
      business_id: appointment.business_id,
      call_type: 'reminder',
      status: 'initiated',
      telnyx_call_id: call.data?.call_control_id,
    });

    res.json({ 
      success: true, 
      message: 'Call initiated',
      call_id: call.data?.call_control_id,
      appointment 
    });
  } catch (error: any) {
    console.error('Error triggering call:', error);
    res.status(500).json({ error: 'Failed to trigger call', details: error.message });
  }
});

// Webhook endpoint for Telnyx call events
app.post('/api/webhooks/telnyx/call-events', async (req, res) => {
  try {
    const event = req.body;
    console.log('Telnyx call event:', JSON.stringify(event, null, 2));

    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;
    const appointmentId = event.data?.payload?.custom_headers?.find(
      (h: any) => h.name === 'X-Appointment-Id'
    )?.value;

    // Handle different call events
    switch (eventType) {
      case 'call.initiated':
        console.log(`Call ${callControlId} initiated`);
        break;

      case 'call.answered':
        console.log(`Call ${callControlId} answered`);
        // Update call log
        if (appointmentId) {
          await supabase
            .from('b2b_call_logs')
            .update({ status: 'answered' })
            .eq('telnyx_call_id', callControlId);
        }
        
        // Speak the reminder message using TTS
        const customerName = event.data?.payload?.custom_headers?.find(
          (h: any) => h.name === 'X-Customer-Name'
        )?.value || 'there';
        const appointmentTitle = event.data?.payload?.custom_headers?.find(
          (h: any) => h.name === 'X-Appointment-Title'
        )?.value || 'your appointment';
        const appointmentTime = event.data?.payload?.custom_headers?.find(
          (h: any) => h.name === 'X-Appointment-Time'
        )?.value;

        const formattedTime = appointmentTime 
          ? new Date(appointmentTime).toLocaleString('en-US', {
              weekday: 'long',
              month: 'long', 
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
          : 'soon';

        // Use Telnyx TTS to speak the reminder
        await telnyx.calls.actions.speak(callControlId, {
          payload: `Hello ${customerName}! This is a reminder about ${appointmentTitle} scheduled for ${formattedTime}. Please press 1 to confirm, or press 2 if you need to reschedule. Thank you!`,
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
        if (digits === '1') {
          await telnyx.calls.actions.speak(callControlId, {
            payload: 'Great! Your appointment is confirmed. We look forward to seeing you. Goodbye!',
            voice: 'female',
            language: 'en-US',
          });
          // Update appointment as confirmed
          if (appointmentId) {
            await supabase
              .from('b2b_appointments')
              .update({ status: 'completed' })
              .eq('id', appointmentId);
          }
        } else if (digits === '2') {
          await telnyx.calls.actions.speak(callControlId, {
            payload: 'No problem. Please contact us to reschedule your appointment. Goodbye!',
            voice: 'female',
            language: 'en-US',
          });
        }
        // Hang up after response
        setTimeout(async () => {
          try {
            await telnyx.calls.actions.hangup(callControlId, {});
          } catch (e) {
            console.log('Call may have already ended');
          }
        }, 5000);
        break;

      case 'call.hangup':
        console.log(`Call ${callControlId} ended`);
        if (callControlId) {
          const duration = event.data?.payload?.duration_secs;
          await supabase
            .from('b2b_call_logs')
            .update({ 
              status: 'completed',
              duration_seconds: duration 
            })
            .eq('telnyx_call_id', callControlId);
        }
        break;

      case 'call.machine.detection.ended':
        const result = event.data?.payload?.result;
        if (result === 'machine') {
          console.log('Voicemail detected, leaving message');
          // Leave voicemail
          await telnyx.calls.actions.speak(callControlId, {
            payload: 'Hello, this is a reminder about your upcoming appointment. Please call us back to confirm. Thank you!',
            voice: 'female',
            language: 'en-US',
          });
        }
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing Telnyx webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Get call logs for a business
app.get('/api/call-logs', async (req, res) => {
  try {
    const { business_id } = req.query;
    
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
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
      .limit(100);

    if (error) throw error;

    res.json({ logs });
  } catch (error) {
    console.error('Error fetching call logs:', error);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// Manual test call endpoint
app.post('/api/test-call', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    console.log(`Making test call to ${phone}`);

    const call = await telnyx.calls.dial({
      connection_id: process.env.TELNYX_CONNECTION_ID!,
      to: phone,
      from: process.env.TELNYX_PHONE_NUMBER!,
      webhook_url: `${process.env.API_URL || 'http://localhost:6001'}/api/webhooks/telnyx/test-call`,
      webhook_url_method: 'POST',
    });

    res.json({ 
      success: true, 
      call_id: call.data?.call_control_id 
    });
  } catch (error: any) {
    console.error('Error making test call:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test call webhook
app.post('/api/webhooks/telnyx/test-call', async (req, res) => {
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
});

const PORT = process.env.PORT || 6001;
app.listen(PORT, () => {
  console.log(`Nemo B2B API running on port ${PORT}`);
  console.log(`Telnyx phone: ${process.env.TELNYX_PHONE_NUMBER}`);
});

export default app;
