import { Router, Request, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';
import { authenticateUser } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Get all available templates (for admin/debugging)
router.get('/api/templates', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { data: templates, error } = await supabase
    .from('b2b_reminder_templates')
    .select('*')
    .order('category_label');

  if (error) {
    log.error('Failed to fetch templates', error);
    throw error;
  }

  res.json({ templates, count: templates?.length || 0 });
}));

// Get template by category
router.get('/api/templates/:category', authenticateUser, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const category = req.params.category as string;

  const { data: template, error } = await supabase
    .from('b2b_reminder_templates')
    .select('*')
    .eq('category', category.toUpperCase())
    .single();

  if (error || !template) {
    // Fall back to OTHER template
    const { data: fallback } = await supabase
      .from('b2b_reminder_templates')
      .select('*')
      .eq('category', 'OTHER')
      .single();

    if (fallback) {
      return res.json({ template: fallback });
    }
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json({ template });
}));

// Get business categories list (for signup dropdown)
router.get('/api/business-categories', (req: Request, res: Response) => {
  const categories = [
    { value: 'BARBERSHOP', label: 'Barbershop', icon: '💈' },
    { value: 'SALON', label: 'Hair Salon', icon: '💇' },
    { value: 'DENTAL', label: 'Dental Office', icon: '🦷' },
    { value: 'MEDICAL', label: 'Medical Clinic', icon: '🏥' },
    { value: 'AUTO_REPAIR', label: 'Auto Repair Shop', icon: '🚗' },
    { value: 'PET_GROOMING', label: 'Pet Grooming', icon: '🐕' },
    { value: 'SPA', label: 'Spa & Wellness', icon: '💆' },
    { value: 'FITNESS', label: 'Fitness & Training', icon: '💪' },
    { value: 'TUTORING', label: 'Tutoring & Education', icon: '📚' },
    { value: 'OTHER', label: 'Other', icon: '🏢' },
  ];
  res.json({ categories });
});

export default router;
