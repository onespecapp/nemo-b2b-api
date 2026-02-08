import { Router, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// List campaigns for business
router.get('/api/campaigns', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  const { data: campaigns, error } = await supabase
    .from('b2b_campaigns')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true });

  if (error) {
    log.error('Failed to fetch campaigns', error);
    throw error;
  }

  res.json({ campaigns: campaigns || [], count: campaigns?.length || 0 });
}));

// Get single campaign with stats
router.get('/api/campaigns/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  const { data: campaign, error } = await supabase
    .from('b2b_campaigns')
    .select('*')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (error || !campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  // Fetch quick stats
  const { count: totalCalls } = await supabase
    .from('b2b_campaign_calls')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id);

  const { count: completedCalls } = await supabase
    .from('b2b_campaign_calls')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id)
    .eq('status', 'COMPLETED');

  const { count: pendingCalls } = await supabase
    .from('b2b_campaign_calls')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id)
    .in('status', ['PENDING', 'QUEUED']);

  res.json({
    campaign,
    stats: {
      total_calls: totalCalls || 0,
      completed_calls: completedCalls || 0,
      pending_calls: pendingCalls || 0,
    },
  });
}));

// Create campaign (one per type per business)
router.post('/api/campaigns', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  const {
    campaign_type,
    name,
    settings,
    call_window_start,
    call_window_end,
    allowed_days,
    max_concurrent_calls,
    min_minutes_between_calls,
    cycle_frequency_days,
  } = req.body;

  const validTypes = ['RE_ENGAGEMENT', 'REVIEW_COLLECTION', 'NO_SHOW_FOLLOWUP'];
  if (!campaign_type || !validTypes.includes(campaign_type)) {
    return res.status(400).json({ error: `Invalid campaign_type. Must be one of: ${validTypes.join(', ')}` });
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  // Check for existing campaign of this type
  const { data: existing } = await supabase
    .from('b2b_campaigns')
    .select('id')
    .eq('business_id', businessId)
    .eq('campaign_type', campaign_type)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'A campaign of this type already exists for your business' });
  }

  const { data: campaign, error } = await supabase
    .from('b2b_campaigns')
    .insert({
      business_id: businessId,
      campaign_type,
      name: name.trim(),
      settings: settings || {},
      call_window_start: call_window_start || '09:00',
      call_window_end: call_window_end || '17:00',
      allowed_days: allowed_days || 'MON,TUE,WED,THU,FRI',
      max_concurrent_calls: max_concurrent_calls || 2,
      min_minutes_between_calls: min_minutes_between_calls || 5,
      cycle_frequency_days: cycle_frequency_days || 30,
    })
    .select()
    .single();

  if (error) {
    log.error('Failed to create campaign', error);
    throw error;
  }

  log.info('Campaign created', { id: campaign.id, type: campaign_type, business: businessId });
  res.status(201).json({ campaign });
}));

// Update campaign settings
router.patch('/api/campaigns/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  // Only allow updating specific fields
  const allowedFields = [
    'name', 'settings', 'call_window_start', 'call_window_end',
    'allowed_days', 'max_concurrent_calls', 'min_minutes_between_calls',
    'cycle_frequency_days',
  ];

  const updates: Record<string, any> = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data: campaign, error } = await supabase
    .from('b2b_campaigns')
    .update(updates)
    .eq('id', id)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    log.error('Failed to update campaign', error);
    throw error;
  }

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  res.json({ campaign });
}));

// Delete campaign
router.delete('/api/campaigns/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  const { error } = await supabase
    .from('b2b_campaigns')
    .delete()
    .eq('id', id)
    .eq('business_id', businessId);

  if (error) {
    log.error('Failed to delete campaign', error);
    throw error;
  }

  res.json({ success: true });
}));

// Toggle campaign enabled/disabled
router.post('/api/campaigns/:id/toggle', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  // Get current state
  const { data: campaign, error: fetchError } = await supabase
    .from('b2b_campaigns')
    .select('enabled')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (fetchError || !campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const newEnabled = !campaign.enabled;

  // When enabling, set next_run_at to now so scheduler picks it up
  const updates: Record<string, any> = { enabled: newEnabled };
  if (newEnabled) {
    updates.next_run_at = new Date().toISOString();
  }

  const { data: updated, error } = await supabase
    .from('b2b_campaigns')
    .update(updates)
    .eq('id', id)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    log.error('Failed to toggle campaign', error);
    throw error;
  }

  log.info('Campaign toggled', { id, enabled: newEnabled });
  res.json({ campaign: updated });
}));

// List campaign calls with outcomes
router.get('/api/campaigns/:id/calls', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;
  const { limit = '50', status: statusFilter } = req.query;

  // Verify campaign ownership
  const { data: campaign } = await supabase
    .from('b2b_campaigns')
    .select('id')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const parsedLimit = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);

  let query = supabase
    .from('b2b_campaign_calls')
    .select(`
      *,
      customer:b2b_customers(name, phone, email),
      call_logs:b2b_call_logs(id, call_outcome, duration_sec, summary, created_at)
    `)
    .eq('campaign_id', id)
    .order('created_at', { ascending: false })
    .limit(parsedLimit);

  if (statusFilter && typeof statusFilter === 'string') {
    query = query.eq('status', statusFilter.toUpperCase());
  }

  const { data: calls, error } = await query;

  if (error) {
    log.error('Failed to fetch campaign calls', error);
    throw error;
  }

  res.json({ calls: calls || [], count: calls?.length || 0 });
}));

// Campaign performance stats
router.get('/api/campaigns/:id/stats', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  // Verify ownership
  const { data: campaign } = await supabase
    .from('b2b_campaigns')
    .select('id, campaign_type')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  // Fetch all campaign calls for aggregation
  const { data: calls, error } = await supabase
    .from('b2b_campaign_calls')
    .select('status, result_data')
    .eq('campaign_id', id);

  if (error) {
    log.error('Failed to fetch campaign stats', error);
    throw error;
  }

  const allCalls = calls || [];
  const completed = allCalls.filter(c => c.status === 'COMPLETED');
  const booked = completed.filter(c => (c.result_data as any)?.booked_appointment === true);
  const declined = completed.filter(c => (c.result_data as any)?.outcome === 'DECLINED');

  const statusBreakdown: Record<string, number> = {};
  for (const call of allCalls) {
    statusBreakdown[call.status] = (statusBreakdown[call.status] || 0) + 1;
  }

  res.json({
    stats: {
      total_calls: allCalls.length,
      completed: completed.length,
      booked: booked.length,
      declined: declined.length,
      conversion_rate: completed.length > 0
        ? Math.round((booked.length / completed.length) * 100)
        : 0,
      status_breakdown: statusBreakdown,
    },
  });
}));

// Get campaign template by type + business category
router.get('/api/campaign-templates/:type/:category', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const campaignType = req.params.type as string;
  const businessCategory = req.params.category as string;

  const { data: template, error } = await supabase
    .from('b2b_campaign_templates')
    .select('*')
    .eq('campaign_type', campaignType.toUpperCase())
    .eq('business_category', businessCategory.toUpperCase())
    .single();

  if (error || !template) {
    // Fall back to OTHER category
    const { data: fallback } = await supabase
      .from('b2b_campaign_templates')
      .select('*')
      .eq('campaign_type', campaignType.toUpperCase())
      .eq('business_category', 'OTHER')
      .single();

    if (fallback) {
      return res.json({ template: fallback });
    }
    return res.status(404).json({ error: 'Campaign template not found' });
  }

  res.json({ template });
}));

export default router;
