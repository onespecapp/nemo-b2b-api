import { Request, Response, NextFunction } from 'express';
import { config, log } from '../config';
import { AuthenticatedRequest } from '../types';

// Phone number validation regex (E.164 format)
export const E164_PHONE_REGEX = /^\+?[1-9]\d{1,14}$/;

// UUID validation regex
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validate phone number format
export function isValidPhoneNumber(phone: string | string[] | undefined): phone is string {
  if (typeof phone !== 'string') return false;
  return E164_PHONE_REGEX.test(phone);
}

// Validate UUID format
export function isValidUUID(id: string | string[] | undefined): id is string {
  if (typeof id !== 'string') return false;
  return UUID_REGEX.test(id);
}

// Verify business ownership for IDOR protection
export const verifyBusinessOwnership = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const businessId = req.query.business_id as string || req.body?.business_id;

  if (!businessId) {
    return next();
  }

  if (!req.user?.business_id) {
    return res.status(403).json({ error: 'No business associated with user' });
  }

  if (businessId !== req.user.business_id) {
    log.debug('Business ownership check failed', {
      requested: businessId,
      owned: req.user.business_id
    });
    return res.status(403).json({ error: 'Access denied to this business data' });
  }

  next();
};

// Telnyx webhook signature validation
export const validateTelnyxWebhook = (req: Request, res: Response, next: NextFunction) => {
  // Skip validation if no webhook secret configured (development)
  if (!config.telnyxWebhookSecret) {
    log.debug('Telnyx webhook validation skipped (no secret configured)');
    return next();
  }

  const signature = req.headers['telnyx-signature-ed25519'] as string;
  const timestamp = req.headers['telnyx-timestamp'] as string;

  if (!signature || !timestamp) {
    log.error('Missing Telnyx webhook signature headers');
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Verify timestamp is recent (within 5 minutes)
  const timestampAge = Math.abs(Date.now() - parseInt(timestamp) * 1000);
  if (timestampAge > 5 * 60 * 1000) {
    log.error('Telnyx webhook timestamp too old', { age: timestampAge });
    return res.status(401).json({ error: 'Webhook timestamp expired' });
  }

  // For production, implement full Ed25519 signature verification
  // This requires the telnyx public key and crypto.verify
  // For now, we do basic timestamp validation

  next();
};
