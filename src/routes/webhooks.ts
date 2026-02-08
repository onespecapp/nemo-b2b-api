import { Router, Request, Response } from 'express';
import { log } from '../config';
import { supabase } from '../clients/supabase';
import { telnyx } from '../clients/telnyx';
import { validateTelnyxWebhook } from '../middleware/validation';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Webhook endpoint for Telnyx call events
router.post('/api/webhooks/telnyx/call-events', validateTelnyxWebhook, asyncHandler(async (req: Request, res: Response) => {
  const event = req.body;
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;

  log.debug('Telnyx webhook received', { eventType, callControlId });

  // Extract custom headers
  const getHeader = (name: string) =>
    event.data?.payload?.custom_headers?.find((h: any) => h.name === name)?.value;

  const appointmentId = getHeader('X-Appointment-Id');
  const customerName = getHeader('X-Customer-Name') || 'there';
  const appointmentTitle = getHeader('X-Appointment-Title') || 'your appointment';
  const appointmentTime = getHeader('X-Appointment-Time');
  const businessName = getHeader('X-Business-Name') || 'our office';
  const businessTimezone = getHeader('X-Business-Timezone');

  switch (eventType) {
    case 'call.initiated':
      log.info('Call initiated', { callControlId });
      break;

    case 'call.answered':
      log.info('Call answered', { callControlId });

      // Update call log
      await supabase
        .from('b2b_call_logs')
        .update({ call_outcome: 'ANSWERED' })
        .eq('sip_call_id', callControlId);

      // Format the appointment time in business timezone
      const formattedTime = appointmentTime
        ? new Date(appointmentTime).toLocaleString('en-US', {
            timeZone: businessTimezone || 'America/Los_Angeles',
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'soon';

      // Speak the reminder message
      await telnyx.calls.actions.speak(callControlId, {
        payload: `Hello ${customerName}! This is a friendly reminder from ${businessName} about ${appointmentTitle} scheduled for ${formattedTime}. Press 1 to confirm your appointment, or press 2 if you need to reschedule. Thank you!`,
        voice: 'female',
        language: 'en-US',
      });
      break;

    case 'call.speak.ended':
      // Gather DTMF input after speaking
      await telnyx.calls.actions.gather(callControlId, {
        minimum_digits: 1,
        maximum_digits: 1,
        timeout_millis: 10000,
      });
      break;

    case 'call.gather.ended':
      const digits = event.data?.payload?.digits;
      log.info('DTMF received', { callControlId, digits });

      if (digits === '1') {
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Great! Your appointment is confirmed. We look forward to seeing you. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });

        if (appointmentId) {
          await supabase
            .from('b2b_appointments')
            .update({ status: 'CONFIRMED' })
            .eq('id', appointmentId);

          await supabase
            .from('b2b_call_logs')
            .update({ call_outcome: 'CONFIRMED' })
            .eq('sip_call_id', callControlId);
        }
      } else if (digits === '2') {
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'No problem. Please contact us to reschedule your appointment. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });

        if (appointmentId) {
          await supabase
            .from('b2b_appointments')
            .update({ status: 'RESCHEDULED' })
            .eq('id', appointmentId);

          await supabase
            .from('b2b_call_logs')
            .update({ call_outcome: 'RESCHEDULED' })
            .eq('sip_call_id', callControlId);
        }
      } else {
        // No input or invalid input - thank them anyway
        await telnyx.calls.actions.speak(callControlId, {
          payload: 'Thank you for your time. If you have questions, please contact us. Goodbye!',
          voice: 'female',
          language: 'en-US',
        });
      }

      // Hang up after response
      setTimeout(async () => {
        try {
          await telnyx.calls.actions.hangup(callControlId, {});
        } catch (e) {
          log.debug('Call may have already ended');
        }
      }, 5000);
      break;

    case 'call.hangup':
      const duration = event.data?.payload?.duration_secs;
      log.info('Call ended', { callControlId, duration });

      await supabase
        .from('b2b_call_logs')
        .update({ duration_sec: duration })
        .eq('sip_call_id', callControlId);
      break;

    case 'call.machine.detection.ended':
      const result = event.data?.payload?.result;
      if (result === 'machine') {
        log.info('Voicemail detected', { callControlId });

        await supabase
          .from('b2b_call_logs')
          .update({ call_outcome: 'VOICEMAIL' })
          .eq('sip_call_id', callControlId);

        await telnyx.calls.actions.speak(callControlId, {
          payload: `Hello, this is a reminder from ${businessName} about your upcoming appointment for ${appointmentTitle}. Please call us back to confirm. Thank you!`,
          voice: 'female',
          language: 'en-US',
        });
      }
      break;
  }

  res.json({ received: true });
}));

export default router;
