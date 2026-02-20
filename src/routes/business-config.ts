import { Router, Request, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser, authenticateInternal } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Get receptionist config
router.get('/api/business/receptionist-config', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  const { data: business, error } = await supabase
    .from('b2b_businesses')
    .select('receptionist_enabled, receptionist_greeting, business_hours, services, faqs, transfer_phone, receptionist_instructions')
    .eq('id', businessId)
    .single();

  if (error || !business) {
    log.error('Failed to fetch receptionist config', error);
    return res.status(404).json({ error: 'Business not found' });
  }

  res.json({ config: business });
}));

// Update receptionist config
router.put('/api/business/receptionist-config', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  const allowedFields = [
    'receptionist_greeting', 'business_hours', 'services', 'faqs',
    'transfer_phone', 'receptionist_instructions',
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

  const { data: business, error } = await supabase
    .from('b2b_businesses')
    .update(updates)
    .eq('id', businessId)
    .select('receptionist_enabled, receptionist_greeting, business_hours, services, faqs, transfer_phone, receptionist_instructions')
    .single();

  if (error) {
    log.error('Failed to update receptionist config', error);
    throw error;
  }

  log.info('Receptionist config updated', { businessId });
  res.json({ config: business });
}));

// Toggle receptionist enabled/disabled
router.post('/api/business/receptionist/toggle', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const businessId = req.user?.business_id;
  if (!businessId) {
    return res.status(400).json({ error: 'No business associated with user' });
  }

  // Get current state
  const { data: business, error: fetchError } = await supabase
    .from('b2b_businesses')
    .select('receptionist_enabled')
    .eq('id', businessId)
    .single();

  if (fetchError || !business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  const newEnabled = !business.receptionist_enabled;

  const { data: updated, error } = await supabase
    .from('b2b_businesses')
    .update({ receptionist_enabled: newEnabled })
    .eq('id', businessId)
    .select('receptionist_enabled')
    .single();

  if (error) {
    log.error('Failed to toggle receptionist', error);
    throw error;
  }

  log.info('Receptionist toggled', { businessId, enabled: newEnabled });
  res.json({ receptionist_enabled: updated.receptionist_enabled });
}));

// Look up business receptionist config by phone number (internal, for voice agent)
router.get('/api/business/by-phone/:phone', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const phone = req.params.phone;

  const { data: business, error } = await supabase
    .from('b2b_businesses')
    .select('id, name, phone, receptionist_enabled, receptionist_greeting, business_hours, services, faqs, transfer_phone, receptionist_instructions, timezone')
    .eq('phone', phone)
    .single();

  if (error || !business) {
    return res.status(404).json({ error: 'Business not found for this phone number' });
  }

  if (!business.receptionist_enabled) {
    return res.status(403).json({ error: 'Receptionist not enabled for this business' });
  }

  res.json({ business });
}));

export default router;
