import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { telnyx } from '../clients/telnyx';
import { livekitEnabled, sipClient, agentDispatch } from '../clients/livekit';
import { validateTelnyxWebhook } from '../middleware/validation';
import { asyncHandler } from '../middleware/error-handler';
import { BusinessHours, InboundCallMetadata } from '../types';

const router = Router();

// Check if current time is within business hours
function isWithinBusinessHours(businessHours: BusinessHours, timezone?: string): boolean {
  const tz = timezone || 'America/Los_Angeles';
  const now = new Date();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  const dayName = dayNames[now.toLocaleString('en-US', { timeZone: tz, weekday: 'narrow' }).length > 0
    ? new Date(now.toLocaleString('en-US', { timeZone: tz })).getDay()
    : now.getDay()];

  const dayConfig = businessHours[dayName];
  if (!dayConfig || dayConfig.closed) return false;

  const nowStr = now.toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const currentTime = nowStr.replace(/[^\d:]/g, '');

  return currentTime >= dayConfig.open && currentTime < dayConfig.close;
}

// Inbound call webhook handler
router.post('/api/webhooks/telnyx/inbound', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;
  const direction = event.data?.payload?.direction;

  log.debug('Inbound webhook received', { eventType, callControlId, direction });

  switch (eventType) {
    case 'call.initiated': {
      if (direction !== 'incoming') {
        log.debug('Ignoring non-incoming call.initiated', { direction });
        return res.json({ received: true });
      }

      const toNumber = event.data?.payload?.to;
      const fromNumber = event.data?.payload?.from;

      log.info('Inbound call received', { to: toNumber, from: fromNumber, callControlId });

      // Look up business by phone number
      const { data: business, error: bizError } = await supabase
        .from('b2b_businesses')
        .select('id, name, phone, receptionist_enabled, receptionist_greeting, business_hours, services, faqs, transfer_phone, receptionist_instructions, timezone')
        .eq('phone', toNumber)
        .single();

      if (bizError || !business) {
        log.info('No business found for number, rejecting', { to: toNumber });
        try {
          await telnyx.calls.actions.hangup(callControlId, {});
        } catch (e) {
          log.debug('Failed to hangup rejected call');
        }
        return res.json({ received: true });
      }

      if (!business.receptionist_enabled) {
        log.info('Receptionist not enabled for business, rejecting', { businessId: business.id });
        try {
          await telnyx.calls.actions.hangup(callControlId, {});
        } catch (e) {
          log.debug('Failed to hangup rejected call');
        }
        return res.json({ received: true });
      }

      // Determine if outside business hours (agent will handle both cases)
      const businessHours = business.business_hours as BusinessHours;
      const isAfterHours = businessHours ? !isWithinBusinessHours(businessHours, business.timezone) : false;

      if (isAfterHours) {
        log.info('Outside business hours, routing to AI agent with after-hours flag', { businessId: business.id });
      }

      // Create call log
      const { data: callLog, error: logError } = await supabase
        .from('b2b_call_logs')
        .insert({
          business_id: business.id,
          call_type: 'INBOUND',
          sip_call_id: callControlId,
          to_number: toNumber,
          from_number: fromNumber,
          call_outcome: 'INITIATED',
        })
        .select('id')
        .single();

      if (logError || !callLog) {
        log.error('Failed to create call log', logError);
        return res.json({ received: true });
      }

      // Set up LiveKit room and agent
      if (!livekitEnabled || !agentDispatch || !config.livekitSipUri) {
        log.error('LiveKit not configured for inbound calls');
        try {
          await telnyx.calls.actions.answer(callControlId, {});
          await telnyx.calls.actions.speak(callControlId, {
            payload: `Thank you for calling ${business.name}. We are unable to take your call right now. Please try again later. Goodbye!`,
            voice: 'female',
            language: 'en-US',
          });
        } catch (e) {
          log.error('Failed to play fallback message', e);
        }
        return res.json({ received: true });
      }

      const roomName = `inbound-${Date.now()}`;

      const metadata: InboundCallMetadata = {
        call_type: 'inbound_receptionist',
        business_id: business.id,
        business_name: business.name,
        receptionist_greeting: business.receptionist_greeting,
        services: business.services || [],
        faqs: business.faqs || [],
        business_hours: businessHours,
        transfer_phone: business.transfer_phone,
        receptionist_instructions: business.receptionist_instructions,
        call_log_id: callLog.id,
        caller_phone: fromNumber,
        is_after_hours: isAfterHours,
      };

      try {
        // Dispatch agent to room first
        log.info('Dispatching agent for inbound call', { roomName, agentName: config.livekitAgentName });
        await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
          metadata: JSON.stringify(metadata),
        });

        // Transfer the inbound call to LiveKit's SIP trunk
        // This connects the caller directly to the LiveKit room via SIP
        const sipUri = `sip:${roomName}@${config.livekitSipUri}`;
        log.info('Transferring inbound call to LiveKit', { roomName, sipUri, callLogId: callLog.id });

        await telnyx.calls.actions.transfer(callControlId, {
          to: sipUri,
        });

        // Update call log with room name
        await supabase
          .from('b2b_call_logs')
          .update({ call_outcome: 'CONNECTED', room_name: roomName })
          .eq('id', callLog.id);
      } catch (error) {
        log.error('Failed to set up LiveKit for inbound call', error);
        try {
          await telnyx.calls.actions.answer(callControlId, {});
          await telnyx.calls.actions.speak(callControlId, {
            payload: `Thank you for calling ${business.name}. We are experiencing technical difficulties. Please try again later. Goodbye!`,
            voice: 'female',
            language: 'en-US',
          });
        } catch (e) {
          log.error('Failed to play error message', e);
        }
      }

      break;
    }

    case 'call.answered':
      log.info('Inbound call answered', { callControlId });
      await supabase
        .from('b2b_call_logs')
        .update({ call_outcome: 'ANSWERED' })
        .eq('sip_call_id', callControlId);
      break;

    case 'call.hangup': {
      const duration = event.data?.payload?.duration_secs;
      log.info('Inbound call ended', { callControlId, duration });

      await supabase
        .from('b2b_call_logs')
        .update({ duration_sec: duration })
        .eq('sip_call_id', callControlId);
      break;
    }

    case 'call.speak.ended':
      // After-hours or error message finished, hang up
      try {
        await telnyx.calls.actions.hangup(callControlId, {});
      } catch (e) {
        log.debug('Call may have already ended');
      }
      break;
  }

  res.json({ received: true });
}));

export default router;
