import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser, authenticateInternal } from '../middleware/auth';
import { isValidUUID } from '../middleware/validation';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Get appointment availability for a given date
router.get('/api/appointments/availability', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { business_id, date, duration_min } = req.query;

  if (!business_id || !date) {
    return res.status(400).json({ error: 'business_id and date are required' });
  }

  const duration = parseInt(duration_min as string) || 60;

  // Get business hours for that day
  const { data: business, error: bizError } = await supabase
    .from('b2b_businesses')
    .select('business_hours, timezone')
    .eq('id', business_id)
    .single();

  if (bizError || !business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const businessHours = business.business_hours as Record<string, any>;
  if (!businessHours) {
    return res.json({ date, slots: [] });
  }

  // Determine day of week for the requested date
  const requestedDate = new Date(date as string + 'T12:00:00');
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[requestedDate.getDay()];
  const dayConfig = businessHours[dayName];

  if (!dayConfig || dayConfig.closed) {
    return res.json({ date, slots: [] });
  }

  const openTime = dayConfig.open || '09:00';
  const closeTime = dayConfig.close || '17:00';

  // Get existing appointments for that date
  const dateStr = date as string;
  const startOfDay = `${dateStr}T00:00:00`;
  const endOfDay = `${dateStr}T23:59:59`;

  const { data: existingAppointments } = await supabase
    .from('b2b_appointments')
    .select('scheduled_at, duration_min')
    .eq('business_id', business_id)
    .gte('scheduled_at', startOfDay)
    .lte('scheduled_at', endOfDay)
    .in('status', ['SCHEDULED', 'CONFIRMED']);

  // Compute available slots
  const slots: { start: string; end: string }[] = [];
  const [openH, openM] = openTime.split(':').map(Number);
  const [closeH, closeM] = closeTime.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  // Generate slots in 30-minute increments
  for (let startMin = openMinutes; startMin + duration <= closeMinutes; startMin += 30) {
    const endMin = startMin + duration;

    // Check for overlap with existing appointments
    const slotStart = `${dateStr}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00`;
    const slotEnd = `${dateStr}T${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00`;

    const hasConflict = existingAppointments?.some(apt => {
      const aptStart = new Date(apt.scheduled_at).getTime();
      const aptEnd = aptStart + (apt.duration_min || 60) * 60 * 1000;
      const slotStartTime = new Date(slotStart).getTime();
      const slotEndTime = new Date(slotEnd).getTime();
      return slotStartTime < aptEnd && slotEndTime > aptStart;
    });

    if (!hasConflict) {
      slots.push({
        start: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`,
        end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
      });
    }
  }

  res.json({ date, slots });
}));

// Book an appointment from an inbound call
router.post('/api/appointments/book-inbound', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { business_id, caller_name, caller_phone, service, scheduled_at, duration_min, notes } = req.body;

  if (!business_id || !caller_name || !caller_phone || !scheduled_at) {
    return res.status(400).json({ error: 'business_id, caller_name, caller_phone, and scheduled_at are required' });
  }

  const duration = duration_min || 60;

  // Find or create customer by phone
  let { data: customer } = await supabase
    .from('b2b_customers')
    .select('id')
    .eq('business_id', business_id)
    .eq('phone', caller_phone)
    .single();

  if (!customer) {
    const { data: newCustomer, error: createError } = await supabase
      .from('b2b_customers')
      .insert({
        business_id,
        name: caller_name,
        phone: caller_phone,
      })
      .select('id')
      .single();

    if (createError) {
      log.error('Failed to create customer', createError);
      return res.status(500).json({ error: 'Failed to create customer' });
    }
    customer = newCustomer;
  }

  // Create the appointment
  const { data: appointment, error: aptError } = await supabase
    .from('b2b_appointments')
    .insert({
      business_id,
      customer_id: customer!.id,
      title: service || 'Appointment',
      description: notes || null,
      scheduled_at,
      duration_min: duration,
      status: 'SCHEDULED',
    })
    .select()
    .single();

  if (aptError) {
    log.error('Failed to create appointment', aptError);
    return res.status(500).json({ error: 'Failed to create appointment' });
  }

  log.info('Appointment booked from inbound call', { appointmentId: appointment.id, customer: caller_name });
  res.status(201).json({ success: true, appointment });
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
