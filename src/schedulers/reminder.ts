import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { telnyx } from '../clients/telnyx';
import { livekitEnabled, sipClient, agentDispatch } from '../clients/livekit';
import { shouldTriggerReminder } from '../utils/reminder-filter';

const SCHEDULER_INTERVAL_MS = 60 * 1000; // Check every minute
let schedulerRunning = false;
const INSTANCE_ID = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function checkAndTriggerReminders() {
  if (schedulerRunning) {
    log.debug('Scheduler already running, skipping...');
    return;
  }

  schedulerRunning = true;
  log.info(`Scheduler: Checking for pending reminders... (instance: ${INSTANCE_ID})`);

  try {
    const now = new Date();

    // Fetch appointments that need reminders
    // Include appointments up to 1 hour in the past (in case scheduler missed them)
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const { data: appointments, error } = await supabase
      .from('b2b_appointments')
      .select(`
        *,
        customer:b2b_customers(*),
        business:b2b_businesses(*)
      `)
      .eq('status', 'SCHEDULED')
      .lte('scheduled_at', new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString())
      .gte('scheduled_at', oneHourAgo.toISOString());

    if (error) {
      log.error('Scheduler: Failed to fetch appointments', error);
      return;
    }

    // Filter to those that need reminders now
    const pendingReminders = appointments?.filter(apt => {
      const result = shouldTriggerReminder(apt, now);
      if (!result) {
        const reminderMinutes = apt.reminder_minutes_before ?? 30;
        const scheduledAt = new Date(apt.scheduled_at);
        const reminderTime = new Date(scheduledAt.getTime() - reminderMinutes * 60 * 1000);
        log.debug(`Scheduler: Skipping appointment ${apt.id}`, {
          reason: new Date(apt.created_at) > reminderTime
            ? 'created after reminder window'
            : 'reminder time not reached yet',
          created_at: apt.created_at,
          scheduled_at: apt.scheduled_at,
          reminder_minutes: reminderMinutes,
          reminder_time: reminderTime.toISOString(),
          now: now.toISOString(),
        });
      }
      return result;
    }) || [];

    if (pendingReminders.length === 0) {
      log.info('Scheduler: No pending reminders');
      return;
    }

    log.info(`Scheduler: Found ${pendingReminders.length} appointments needing reminders`);

    // Trigger calls for each appointment
    for (const appointment of pendingReminders) {
      try {
        const customerPhone = appointment.customer?.phone;
        if (!customerPhone) {
          log.error(`Scheduler: No phone for appointment ${appointment.id}`);
          continue;
        }

        // Validate phone number
        if (!customerPhone.match(/^\+?[1-9]\d{1,14}$/)) {
          log.error(`Scheduler: Invalid phone for appointment ${appointment.id}: ${customerPhone}`);
          continue;
        }

        // ATOMICALLY claim this appointment to prevent duplicate calls from multiple instances
        // Only update if status is still SCHEDULED (prevents race condition)
        const { data: claimedRows, error: claimError } = await supabase
          .from('b2b_appointments')
          .update({ status: 'REMINDED', updated_at: new Date().toISOString() })
          .eq('id', appointment.id)
          .eq('status', 'SCHEDULED')  // Only if still SCHEDULED
          .select();

        // If no rows updated, appointment was already claimed by another instance
        if (claimError) {
          log.error(`Scheduler: Error claiming appointment ${appointment.id}`, claimError);
          continue;
        }

        if (!claimedRows || claimedRows.length === 0) {
          log.info(`Scheduler: Appointment ${appointment.id} already claimed by another instance, skipping`);
          continue;
        }

        const claimed = claimedRows[0];

        log.info(`Scheduler: Triggering call for appointment ${appointment.id}`, {
          customer: appointment.customer?.name,
          phone: customerPhone,
          scheduledAt: appointment.scheduled_at,
        });

        // Fetch template for business category
        const businessCategory = appointment.business?.category || 'OTHER';
        const { data: template } = await supabase
          .from('b2b_reminder_templates')
          .select('*')
          .eq('category', businessCategory)
          .single();

        // Use LiveKit if available
        if (livekitEnabled && sipClient && agentDispatch) {
          const roomName = `reminder-${appointment.id}-${Date.now()}`;

          const metadata = JSON.stringify({
            call_type: 'reminder',
            voice_preference: appointment.business?.voice_preference || 'Aoede',
            appointment: {
              id: appointment.id,
              title: appointment.title,
              scheduled_at: appointment.scheduled_at,
              customer_name: appointment.customer?.name,
              business_name: appointment.business?.name,
              business_category: businessCategory,
              business_timezone: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles',
            },
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

          await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
            metadata: metadata,
          });

          const sipCall = await sipClient.createSipParticipant(
            config.livekitSipTrunkId,
            customerPhone,
            roomName,
            {
              participantIdentity: `customer-${appointment.customer_id}`,
              participantName: appointment.customer?.name || 'Customer',
              playDialtone: false,
            }
          );

          log.info(`Scheduler: LiveKit call created for ${appointment.id}`, { roomName, sipCallId: sipCall.sipCallId });

          // Log the call
          await supabase.from('b2b_call_logs').insert({
            appointment_id: appointment.id,
            customer_id: appointment.customer_id,
            business_id: appointment.business_id,
            call_type: 'REMINDER',
            room_name: roomName,
            sip_call_id: sipCall.sipCallId,
          });

        } else {
          // Fallback to Telnyx
          const call = await telnyx.calls.dial({
            connection_id: config.telnyxConnectionId,
            to: customerPhone,
            from: config.telnyxPhoneNumber,
            webhook_url: `${config.apiUrl}/api/webhooks/telnyx/call-events`,
            webhook_url_method: 'POST',
            custom_headers: [
              { name: 'X-Appointment-Id', value: appointment.id },
              { name: 'X-Customer-Name', value: appointment.customer?.name || 'Customer' },
              { name: 'X-Appointment-Title', value: appointment.title },
              { name: 'X-Appointment-Time', value: appointment.scheduled_at },
              { name: 'X-Business-Name', value: appointment.business?.name || 'Our office' },
              { name: 'X-Business-Category', value: businessCategory },
              { name: 'X-Business-Timezone', value: appointment.customer?.timezone || appointment.business?.timezone || 'America/Los_Angeles' },
            ],
          });

          log.info(`Scheduler: Telnyx call created for ${appointment.id}`, { callId: call.data?.call_control_id });

          // Note: Status already updated to REMINDED above (atomic claim)

          await supabase.from('b2b_call_logs').insert({
            appointment_id: appointment.id,
            customer_id: appointment.customer_id,
            business_id: appointment.business_id,
            call_type: 'REMINDER',
            sip_call_id: call.data?.call_control_id,
          });
        }

      } catch (callError) {
        log.error(`Scheduler: Failed to trigger call for appointment ${appointment.id}`, callError);
        // If call failed, revert status back to SCHEDULED so it can be retried
        await supabase
          .from('b2b_appointments')
          .update({ status: 'SCHEDULED' })
          .eq('id', appointment.id);
      }
    }

  } catch (err) {
    log.error('Scheduler: Unexpected error', err);
  } finally {
    schedulerRunning = false;
  }
}

// Start the reminder scheduler
export function startReminderScheduler() {
  log.info('Starting reminder scheduler (interval: 60s)');

  // Run immediately on startup
  setTimeout(() => checkAndTriggerReminders(), 5000);

  // Then run every minute
  setInterval(checkAndTriggerReminders, SCHEDULER_INTERVAL_MS);
}
