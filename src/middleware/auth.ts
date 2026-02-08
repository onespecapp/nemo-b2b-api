import { Response, NextFunction } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { AuthenticatedRequest } from '../types';

// Authentication middleware using Supabase JWT
export const authenticateUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify the JWT with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      log.debug('Auth failed', { error: error?.message });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get the user's business
    const { data: business } = await supabase
      .from('b2b_businesses')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email,
      business_id: business?.id,
    };

    next();
  } catch (error) {
    log.error('Authentication error', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Internal API key authentication (for agent callbacks)
export const authenticateInternal = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // Skip auth if no internal API key is configured (development mode)
  if (!config.internalApiKey) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.substring(7);

  if (token !== config.internalApiKey) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
};
