import { Router, Request, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser, authenticateInternal } from '../middleware/auth';
import { isValidUUID, verifyBusinessOwnership } from '../middleware/validation';
import { asyncHandler } from '../middleware/error-handler';
import { analyzeTranscriptWithGemini } from '../services/gemini-analysis';

const router = Router();

// Get call logs for a business
router.get('/api/call-logs', authenticateUser, verifyBusinessOwnership, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/api/calls/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/api/calls/by-room/:roomName', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
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

// Save call transcript (called by agent at end of call)
router.post('/api/calls/:id/transcript', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
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

// Agent error reporting - allows the agent to report crashes/errors for visibility
router.post('/api/calls/by-room/:roomName/error', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { roomName } = req.params;
  const { error, timestamp } = req.body;
  log.error('AGENT ERROR REPORT', { roomName, error, timestamp });

  // Update call log if it exists
  await supabase.from('b2b_call_logs')
    .update({ notes: `Agent error: ${(error || '').slice(0, 500)}`, call_outcome: 'ERROR' })
    .eq('room_name', roomName);

  res.json({ ok: true });
}));

export default router;
