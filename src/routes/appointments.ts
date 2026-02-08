import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { telnyx } from '../clients/telnyx';
import { livekitEnabled, sipClient, agentDispatch } from '../clients/livekit';
import { AuthenticatedRequest } from '../types';
import { authenticateUser, authenticateInternal } from '../middleware/auth';
import { isValidUUID } from '../middleware/validation';
import { callRateLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Get upcoming appointments that need reminders (internal use by scheduler)
router.get('/api/appointments/pending-reminders', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/api/appointments/:id/trigger-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
        voice_preference: appointment.business?.voice_preference || 'Aoede',
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

// Update appointment status (called by agent on confirm/cancel)
router.patch('/api/appointments/:id/status', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
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
router.post('/api/appointments/:id/reschedule', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
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

export default router;
