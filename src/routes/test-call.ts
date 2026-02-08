import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { telnyx } from '../clients/telnyx';
import { livekitEnabled, sipClient, agentDispatch } from '../clients/livekit';
import { AuthenticatedRequest } from '../types';
import { authenticateUser } from '../middleware/auth';
import { isValidPhoneNumber, isValidUUID, validateTelnyxWebhook } from '../middleware/validation';
import { callRateLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Manual test call endpoint (uses basic TTS)
router.post('/api/test-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { phone, message, voice_preference, business_name, business_id, business_category } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  // Validate phone number format
  if (!isValidPhoneNumber(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  // Validate business_id if provided
  if (business_id && !isValidUUID(business_id)) {
    return res.status(400).json({ error: 'Invalid business_id format' });
  }

  log.info('Making test call', { phone, livekitEnabled, business_category });

  // Fetch template if category provided
  let template = null;
  if (business_category || business_id) {
    let category = business_category;

    // If business_id provided, fetch the business to get category
    if (business_id && !category) {
      const { data: business } = await supabase
        .from('b2b_businesses')
        .select('category')
        .eq('id', business_id)
        .single();
      category = business?.category || 'OTHER';
    }

    // Fetch template for this category
    const { data: templateData } = await supabase
      .from('b2b_reminder_templates')
      .select('*')
      .eq('category', category || 'OTHER')
      .single();

    template = templateData;
    log.info('Using template for category', { category, hasTemplate: !!template });
  }

  // Use LiveKit if configured (Gemini voice), otherwise fall back to Telnyx TTS
  if (livekitEnabled && sipClient && agentDispatch) {
    try {
      // Create a unique room for this call
      const roomName = `test-call-${Date.now()}`;

      // Prepare metadata for the agent (include template if available)
      const metadata = JSON.stringify({
        call_type: 'test',
        voice_preference: voice_preference || 'Aoede',
        family_name: business_name || 'Nemo B2B',
        recipient_preferred_name: 'there',
        greeting_message: message || 'Hello! This is a test call from Nemo. How do I sound?',
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

      // First, dispatch the agent to the room so it's ready when the call connects
      log.info('Dispatching agent to room', { roomName, agentName: config.livekitAgentName });
      await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
        metadata: metadata,
      });

      // Create outbound SIP call via LiveKit
      const sipCall = await sipClient.createSipParticipant(
        config.livekitSipTrunkId,
        phone,
        roomName,
        {
          participantIdentity: `caller-${Date.now()}`,
          participantName: 'Test Call Recipient',
          playDialtone: false,
        }
      );

      log.info('LiveKit SIP call created', { roomName, sipCallId: sipCall.sipCallId });

      return res.json({
        success: true,
        message: 'Test call initiated via Gemini AI',
        room_name: roomName,
        sip_call_id: sipCall.sipCallId,
        voice: voice_preference || 'Aoede',
      });
    } catch (error: any) {
      log.error('LiveKit call failed, falling back to Telnyx', error);
      // Fall through to Telnyx
    }
  }

  // Fallback: Use Telnyx with basic TTS
  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: phone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/test-call`,
    webhook_url_method: 'POST',
  });

  res.json({
    success: true,
    message: 'Test call initiated (basic TTS)',
    call_id: call.data?.call_control_id
  });
}));

// Test call webhook (basic TTS)
router.post('/api/webhooks/telnyx/test-call', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;

  if (eventType === 'call.answered') {
    await telnyx.calls.actions.speak(callControlId, {
      payload: 'Hello! This is a test call from Nemo B2B. Your appointment reminder system is working correctly. Goodbye!',
      voice: 'female',
      language: 'en-US',
    });
  } else if (eventType === 'call.speak.ended') {
    await telnyx.calls.actions.hangup(callControlId, {});
  }

  res.json({ received: true });
}));

export default router;
