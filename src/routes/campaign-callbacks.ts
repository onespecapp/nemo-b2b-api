import { Router, Request, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { authenticateInternal } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Agent reports campaign call outcome
router.post('/api/campaign-calls/:id/result', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { outcome, result_data, summary } = req.body;

  log.info('Campaign call result reported', { id, outcome, result_data });

  const updates: Record<string, any> = {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    result_data: result_data || {},
  };

  const { data: campaignCall, error } = await supabase
    .from('b2b_campaign_calls')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    log.error('Failed to update campaign call result', error);
    throw error;
  }

  // Also update linked call log outcome if there is one
  if (campaignCall) {
    const validOutcomes = ['ANSWERED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'FAILED', 'BOOKED', 'DECLINED', 'REVIEW_SENT'];
    const callOutcome = outcome && validOutcomes.includes(outcome.toUpperCase())
      ? outcome.toUpperCase()
      : 'ANSWERED';

    await supabase
      .from('b2b_call_logs')
      .update({
        call_outcome: callOutcome,
        summary: summary || null,
      })
      .eq('campaign_call_id', id);
  }

  res.json({ success: true, campaign_call: campaignCall });
}));

// Agent books appointment during campaign call
router.post('/api/appointments/create-from-campaign', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { campaign_call_id, customer_id, business_id, title, scheduled_at, duration_min } = req.body;

  if (!customer_id || !business_id || !title || !scheduled_at) {
    return res.status(400).json({ error: 'customer_id, business_id, title, and scheduled_at are required' });
  }

  log.info('Creating appointment from campaign call', { campaign_call_id, customer_id, title, scheduled_at });

  // Create the appointment
  const { data: appointment, error } = await supabase
    .from('b2b_appointments')
    .insert({
      title,
      scheduled_at,
      duration_min: duration_min || 30,
      status: 'SCHEDULED',
      business_id,
      customer_id,
      reminder_enabled: true,
    })
    .select()
    .single();

  if (error) {
    log.error('Failed to create appointment from campaign', error);
    throw error;
  }

  // Update campaign call result_data to include booked appointment
  if (campaign_call_id) {
    await supabase
      .from('b2b_campaign_calls')
      .update({
        result_data: { booked_appointment: true, appointment_id: appointment.id },
      })
      .eq('id', campaign_call_id);
  }

  res.status(201).json({ success: true, appointment });
}));

export default router;
