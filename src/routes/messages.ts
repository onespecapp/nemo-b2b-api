import { Router, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser } from '../middleware/auth';
import { authenticateInternal } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// List messages for business
router.get('/api/messages', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  const { limit = '50', offset = '0', urgency, read: readFilter } = req.query;

  const parsedLimit = Math.min(Math.max(1, parseInt(limit as string) || 50), 100);
  const parsedOffset = Math.max(0, parseInt(offset as string) || 0);

  let query = supabase
    .from('b2b_messages')
    .select('*', { count: 'exact' })
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .range(parsedOffset, parsedOffset + parsedLimit - 1);

  if (urgency && typeof urgency === 'string') {
    query = query.eq('urgency', urgency);
  }

  if (readFilter !== undefined && typeof readFilter === 'string') {
    query = query.eq('read', readFilter === 'true');
  }

  const { data: messages, error, count } = await query;

  if (error) {
    log.error('Failed to fetch messages', error);
    throw error;
  }

  res.json({ messages: messages || [], count: count || 0 });
}));

// Get single message
router.get('/api/messages/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  const { data: message, error } = await supabase
    .from('b2b_messages')
    .select('*')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (error || !message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  res.json({ message });
}));

// Toggle read status
router.patch('/api/messages/:id/read', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  // Get current state
  const { data: message, error: fetchError } = await supabase
    .from('b2b_messages')
    .select('read')
    .eq('id', id)
    .eq('business_id', businessId)
    .single();

  if (fetchError || !message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const newRead = !message.read;

  const { data: updated, error } = await supabase
    .from('b2b_messages')
    .update({ read: newRead, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    log.error('Failed to update message read status', error);
    throw error;
  }

  res.json({ message: updated });
}));

// Delete message
router.delete('/api/messages/:id', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const businessId = req.user?.business_id;

  const { error } = await supabase
    .from('b2b_messages')
    .delete()
    .eq('id', id)
    .eq('business_id', businessId);

  if (error) {
    log.error('Failed to delete message', error);
    throw error;
  }

  res.json({ success: true });
}));

// Create message (used by LiveKit agent via internal API key)
router.post('/api/messages', authenticateInternal, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { business_id, call_log_id, caller_name, caller_phone, message, reason, urgency } = req.body;

  if (!business_id) {
    return res.status(400).json({ error: 'business_id is required' });
  }

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const validUrgencies = ['normal', 'urgent', 'low'];
  const msgUrgency = urgency && validUrgencies.includes(urgency) ? urgency : 'normal';

  const { data: newMessage, error } = await supabase
    .from('b2b_messages')
    .insert({
      business_id,
      call_log_id: call_log_id || null,
      caller_name: caller_name || null,
      caller_phone: caller_phone || null,
      message,
      reason: reason || null,
      urgency: msgUrgency,
    })
    .select()
    .single();

  if (error) {
    log.error('Failed to create message', error);
    throw error;
  }

  log.info('Message created', { id: newMessage.id, businessId: business_id, urgency: msgUrgency });
  res.status(201).json({ message: newMessage });
}));

export default router;
