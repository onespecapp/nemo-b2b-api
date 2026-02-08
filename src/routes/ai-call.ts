import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { telnyx } from '../clients/telnyx';
import { googleAI } from '../clients/google-ai';
import { AuthenticatedRequest } from '../types';
import { authenticateUser } from '../middleware/auth';
import { isValidPhoneNumber, validateTelnyxWebhook } from '../middleware/validation';
import { callRateLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';
import { geminiSessions, createGeminiLiveSession, closeGeminiSession } from '../services/gemini-session';

const router = Router();

// AI test call endpoint - uses Gemini Live for natural conversation
router.post('/api/ai-call', authenticateUser, callRateLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { phone, systemPrompt } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required in request body' });
  }

  if (!googleAI) {
    return res.status(503).json({ error: 'Gemini Live not configured' });
  }

  // Validate phone number format
  if (!isValidPhoneNumber(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g., +1234567890)' });
  }

  const defaultPrompt = `You are Nemo, a friendly and helpful AI assistant making a phone call.
You work for an appointment reminder service. Be warm, conversational, and natural.
Keep responses concise since this is a phone call.
If the user asks about their appointment, explain you're calling to remind them about their upcoming appointment.
If they want to confirm, thank them warmly. If they want to reschedule, be understanding and helpful.`;

  log.info('Making AI call with Gemini Live', { phone });

  const call = await telnyx.calls.dial({
    connection_id: config.telnyxConnectionId,
    to: phone,
    from: config.telnyxPhoneNumber,
    webhook_url: `${config.apiUrl}/api/webhooks/telnyx/ai-call`,
    webhook_url_method: 'POST',
    custom_headers: [
      { name: 'X-System-Prompt', value: Buffer.from(systemPrompt || defaultPrompt).toString('base64') },
    ],
  });

  res.json({
    success: true,
    message: 'AI call initiated with Gemini Live',
    call_id: call.data?.call_control_id
  });
}));

// AI call webhook - handles Gemini Live streaming
router.post('/api/webhooks/telnyx/ai-call', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;

  log.debug('AI call webhook received', { eventType, callControlId });

  const getHeader = (name: string) =>
    event.data?.payload?.custom_headers?.find((h: any) => h.name === name)?.value;

  switch (eventType) {
    case 'call.initiated':
      log.info('AI call initiated', { callControlId });
      break;

    case 'call.answered':
      log.info('AI call answered', { callControlId });

      // Get system prompt from headers
      const encodedPrompt = getHeader('X-System-Prompt');
      const systemPrompt = encodedPrompt
        ? Buffer.from(encodedPrompt, 'base64').toString('utf-8')
        : 'You are Nemo, a friendly AI assistant. Be helpful and concise.';

      // Create Gemini Live session
      const session = await createGeminiLiveSession(callControlId, systemPrompt);

      if (!session) {
        log.error('Failed to create Gemini session, falling back to TTS');
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Hello! I apologize, but I am having trouble connecting. Please try again later. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
        return res.json({ received: true });
      }

      // Start bidirectional audio streaming with Telnyx
      // The stream_url should point to our WebSocket server
      try {
        // Use type assertion since SDK types may not include all methods
        await (telnyx.calls.actions as any).streamingStart(callControlId, {
          stream_url: `${config.wsUrl}/media-stream?call_control_id=${callControlId}`,
          stream_track: 'both_tracks',
        });
        log.info('Started Telnyx media streaming', { callControlId });

        // Send initial greeting via Gemini
        await session.liveSession.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{ text: 'The call has just started. Please greet the caller warmly and introduce yourself.' }],
          }],
          turnComplete: true,
        });
      } catch (streamError) {
        log.error('Failed to start media streaming', streamError);
        // Fallback to basic TTS if streaming fails
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Hello! This is Nemo, your AI assistant. How can I help you today?',
          voice: 'female',
          language: 'en-US',
        });
      }
      break;

    case 'call.streaming.started':
      log.info('Media streaming started', { callControlId });
      break;

    case 'call.streaming.stopped':
      log.info('Media streaming stopped', { callControlId });
      break;

    case 'call.hangup':
      log.info('AI call ended', { callControlId });
      await closeGeminiSession(callControlId);
      break;

    case 'call.speak.ended':
      // If we fell back to TTS, hang up after speaking
      const session2 = geminiSessions.get(callControlId);
      if (!session2) {
        await telnyx.calls.actions.hangup(callControlId, {});
      }
      break;
  }

  res.json({ received: true });
}));

export default router;
