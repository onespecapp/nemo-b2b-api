import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { livekitEnabled, sipClient, agentDispatch } from '../clients/livekit';

const CAMPAIGN_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let campaignSchedulerRunning = false;

// Parse HH:MM time string to minutes since midnight
function parseTimeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

// Get current day abbreviation in business timezone
function getDayAbbrev(date: Date, timezone: string): string {
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: timezone }).toUpperCase();
  return dayName.slice(0, 3); // MON, TUE, etc.
}

// Get current time as minutes since midnight in business timezone
function getCurrentMinutesInTimezone(timezone: string): number {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return parseTimeToMinutes(timeStr);
}

// Check if now is within the campaign's call window
function isWithinCallWindow(campaign: any, timezone: string): boolean {
  const now = new Date();
  const currentDay = getDayAbbrev(now, timezone);
  const allowedDays = (campaign.allowed_days || 'MON,TUE,WED,THU,FRI').split(',').map((d: string) => d.trim());

  if (!allowedDays.includes(currentDay)) {
    return false;
  }

  const currentMinutes = getCurrentMinutesInTimezone(timezone);
  const windowStart = parseTimeToMinutes(campaign.call_window_start || '09:00');
  const windowEnd = parseTimeToMinutes(campaign.call_window_end || '17:00');

  return currentMinutes >= windowStart && currentMinutes <= windowEnd;
}

export async function runCampaignScheduler() {
  if (campaignSchedulerRunning) {
    log.debug('Campaign scheduler already running, skipping...');
    return;
  }

  campaignSchedulerRunning = true;
  log.info('Campaign scheduler: Running...');

  try {
    const now = new Date();

    // Fetch all enabled campaigns with their business timezone
    const { data: campaigns, error } = await supabase
      .from('b2b_campaigns')
      .select('*, business:b2b_businesses(timezone, category, voice_preference, name)')
      .eq('enabled', true);

    if (error) {
      log.error('Campaign scheduler: Failed to fetch campaigns', error);
      return;
    }

    if (!campaigns || campaigns.length === 0) {
      log.debug('Campaign scheduler: No enabled campaigns');
      return;
    }

    for (const campaign of campaigns) {
      try {
        const timezone = campaign.business?.timezone || 'America/Los_Angeles';

        // Check if within call window
        if (!isWithinCallWindow(campaign, timezone)) {
          log.debug(`Campaign ${campaign.id}: Outside call window`);
          continue;
        }

        // === DISPATCH PHASE ===
        // Find QUEUED campaign_calls where scheduled_for <= NOW
        const { data: queuedCalls, error: queueError } = await supabase
          .from('b2b_campaign_calls')
          .select('*, customer:b2b_customers(*)')
          .eq('campaign_id', campaign.id)
          .eq('status', 'QUEUED')
          .lte('scheduled_for', now.toISOString())
          .order('scheduled_for', { ascending: true });

        if (queueError) {
          log.error(`Campaign ${campaign.id}: Error fetching queued calls`, queueError);
          continue;
        }

        if (queuedCalls && queuedCalls.length > 0) {
          // Count current IN_PROGRESS calls to respect max_concurrent_calls
          const { count: inProgressCount } = await supabase
            .from('b2b_campaign_calls')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', campaign.id)
            .eq('status', 'IN_PROGRESS');

          let currentInProgress = inProgressCount || 0;

          // Check last dispatch time for min_minutes_between_calls
          const { data: lastDispatched } = await supabase
            .from('b2b_campaign_calls')
            .select('started_at')
            .eq('campaign_id', campaign.id)
            .in('status', ['IN_PROGRESS', 'COMPLETED'])
            .order('started_at', { ascending: false })
            .limit(1)
            .single();

          const minMsBetween = (campaign.min_minutes_between_calls || 5) * 60 * 1000;
          if (lastDispatched?.started_at) {
            const timeSinceLast = now.getTime() - new Date(lastDispatched.started_at).getTime();
            if (timeSinceLast < minMsBetween) {
              log.debug(`Campaign ${campaign.id}: Too soon since last dispatch (${Math.round(timeSinceLast / 1000)}s)`);
              continue;
            }
          }

          for (const campaignCall of queuedCalls) {
            if (currentInProgress >= (campaign.max_concurrent_calls || 2)) {
              log.debug(`Campaign ${campaign.id}: Max concurrent calls reached`);
              break;
            }

            const customer = campaignCall.customer;
            if (!customer?.phone || !customer.phone.match(/^\+?[1-9]\d{1,14}$/)) {
              // Skip invalid phone
              await supabase
                .from('b2b_campaign_calls')
                .update({ status: 'SKIPPED', skip_reason: 'Invalid phone number' })
                .eq('id', campaignCall.id)
                .eq('status', 'QUEUED');
              continue;
            }

            // Atomically claim the call
            const { data: claimed, error: claimError } = await supabase
              .from('b2b_campaign_calls')
              .update({ status: 'IN_PROGRESS', started_at: now.toISOString() })
              .eq('id', campaignCall.id)
              .eq('status', 'QUEUED')
              .select()
              .single();

            if (claimError || !claimed) {
              continue; // Already claimed
            }

            // Fetch campaign template
            const businessCategory = campaign.business?.category || 'OTHER';
            const { data: template } = await supabase
              .from('b2b_campaign_templates')
              .select('*')
              .eq('campaign_type', campaign.campaign_type)
              .eq('business_category', businessCategory)
              .single();

            // Dispatch the call via LiveKit
            if (livekitEnabled && sipClient && agentDispatch) {
              try {
                const roomName = `campaign-${campaign.campaign_type.toLowerCase()}-${campaignCall.id}-${Date.now()}`;

                const callTypeMap: Record<string, string> = {
                  RE_ENGAGEMENT: 're_engagement',
                  REVIEW_COLLECTION: 'review_collection',
                  NO_SHOW_FOLLOWUP: 'no_show_followup',
                };

                const metadata = JSON.stringify({
                  call_type: callTypeMap[campaign.campaign_type] || 're_engagement',
                  voice_preference: campaign.business?.voice_preference || 'Aoede',
                  campaign_call_id: campaignCall.id,
                  campaign_id: campaign.id,
                  customer: {
                    id: customer.id,
                    name: customer.name,
                    phone: customer.phone,
                  },
                  business: {
                    id: campaign.business_id,
                    name: campaign.business?.name,
                    category: businessCategory,
                    timezone,
                  },
                  template: template ? {
                    system_prompt: template.system_prompt,
                    greeting: template.greeting,
                    goal_prompt: template.goal_prompt,
                    closing: template.closing,
                    voicemail: template.voicemail,
                  } : null,
                  settings: campaign.settings,
                });

                await agentDispatch.createDispatch(roomName, config.livekitAgentName, {
                  metadata,
                });

                const sipCall = await sipClient.createSipParticipant(
                  config.livekitSipTrunkId,
                  customer.phone,
                  roomName,
                  {
                    participantIdentity: `customer-${customer.id}`,
                    participantName: customer.name || 'Customer',
                    playDialtone: false,
                  }
                );

                // Create call log linked to campaign call
                const callTypeDbMap: Record<string, string> = {
                  RE_ENGAGEMENT: 'RE_ENGAGEMENT',
                  REVIEW_COLLECTION: 'REVIEW_COLLECTION',
                  NO_SHOW_FOLLOWUP: 'NO_SHOW_FOLLOWUP',
                };

                await supabase.from('b2b_call_logs').insert({
                  business_id: campaign.business_id,
                  customer_id: customer.id,
                  call_type: callTypeDbMap[campaign.campaign_type] || 'RE_ENGAGEMENT',
                  campaign_call_id: campaignCall.id,
                  room_name: roomName,
                  sip_call_id: sipCall.sipCallId,
                });

                currentInProgress++;
                log.info(`Campaign scheduler: Dispatched call for ${customer.name}`, {
                  campaign: campaign.id,
                  campaignCall: campaignCall.id,
                  roomName,
                });
              } catch (callError) {
                log.error(`Campaign scheduler: Call dispatch failed for ${campaignCall.id}`, callError);
                // Revert to QUEUED for retry
                await supabase
                  .from('b2b_campaign_calls')
                  .update({ status: 'QUEUED', started_at: null })
                  .eq('id', campaignCall.id);
              }
            } else {
              // No LiveKit - mark as failed
              await supabase
                .from('b2b_campaign_calls')
                .update({ status: 'FAILED', skip_reason: 'LiveKit not configured' })
                .eq('id', campaignCall.id);
            }
          }
        }

        // === EVALUATION PHASE ===
        // If next_run_at <= NOW, generate new candidate calls
        if (campaign.next_run_at && new Date(campaign.next_run_at) <= now) {
          log.info(`Campaign ${campaign.id}: Running evaluation phase`);

          if (campaign.campaign_type === 'RE_ENGAGEMENT') {
            const settings = (campaign.settings || {}) as Record<string, any>;
            const daysSinceLastAppointment = settings.days_since_last_appointment || 30;
            const cutoffDate = new Date(now.getTime() - daysSinceLastAppointment * 24 * 60 * 60 * 1000);

            // Find eligible customers:
            // 1. Belong to this business
            // 2. Have a valid phone number
            // 3. Last appointment was before cutoff (or no appointments)
            // 4. No future appointment scheduled
            // 5. Not already called in this campaign cycle
            const { data: customers, error: custError } = await supabase
              .from('b2b_customers')
              .select('id, name, phone')
              .eq('business_id', campaign.business_id)
              .neq('phone', '');

            if (custError || !customers) {
              log.error(`Campaign ${campaign.id}: Error fetching customers`, custError);
              continue;
            }

            const eligibleCustomers: typeof customers = [];

            for (const customer of customers) {
              if (!customer.phone?.match(/^\+?[1-9]\d{1,14}$/)) continue;

              // Check last appointment
              const { data: lastApt } = await supabase
                .from('b2b_appointments')
                .select('scheduled_at')
                .eq('customer_id', customer.id)
                .eq('business_id', campaign.business_id)
                .order('scheduled_at', { ascending: false })
                .limit(1)
                .single();

              // Skip if customer has a recent or future appointment
              if (lastApt) {
                const lastAptDate = new Date(lastApt.scheduled_at);
                if (lastAptDate > cutoffDate) continue; // Too recent
              }

              // Check for future appointments
              const { count: futureCount } = await supabase
                .from('b2b_appointments')
                .select('*', { count: 'exact', head: true })
                .eq('customer_id', customer.id)
                .eq('business_id', campaign.business_id)
                .gte('scheduled_at', now.toISOString())
                .in('status', ['SCHEDULED', 'CONFIRMED']);

              if (futureCount && futureCount > 0) continue; // Already has future appointment

              // Check if already called in this cycle
              const cycleStart = new Date(now.getTime() - (campaign.cycle_frequency_days || 30) * 24 * 60 * 60 * 1000);
              const { count: recentCallCount } = await supabase
                .from('b2b_campaign_calls')
                .select('*', { count: 'exact', head: true })
                .eq('campaign_id', campaign.id)
                .eq('customer_id', customer.id)
                .gte('created_at', cycleStart.toISOString());

              if (recentCallCount && recentCallCount > 0) continue; // Already called

              eligibleCustomers.push(customer);
            }

            log.info(`Campaign ${campaign.id}: Found ${eligibleCustomers.length} eligible customers`);

            if (eligibleCustomers.length > 0) {
              // Stagger scheduled_for times across the call window
              const windowStartMin = parseTimeToMinutes(campaign.call_window_start || '09:00');
              const windowEndMin = parseTimeToMinutes(campaign.call_window_end || '17:00');
              const windowDurationMin = windowEndMin - windowStartMin;
              const intervalMin = Math.max(
                campaign.min_minutes_between_calls || 5,
                Math.floor(windowDurationMin / Math.max(eligibleCustomers.length, 1))
              );

              // Schedule calls starting from next call window
              const tomorrow = new Date(now);
              tomorrow.setDate(tomorrow.getDate() + 1);

              for (let i = 0; i < eligibleCustomers.length; i++) {
                const customer = eligibleCustomers[i];
                const offsetMinutes = windowStartMin + (i * intervalMin);

                // If offset exceeds window, schedule for next day
                const dayOffset = Math.floor((offsetMinutes - windowStartMin) / windowDurationMin);
                const minuteInWindow = windowStartMin + ((offsetMinutes - windowStartMin) % windowDurationMin);

                const scheduledDate = new Date(tomorrow);
                scheduledDate.setDate(scheduledDate.getDate() + dayOffset);
                // Set time in UTC (approximate - the call window check will gate actual dispatch)
                scheduledDate.setHours(0, 0, 0, 0);
                scheduledDate.setMinutes(minuteInWindow);

                await supabase.from('b2b_campaign_calls').insert({
                  campaign_id: campaign.id,
                  customer_id: customer.id,
                  business_id: campaign.business_id,
                  status: 'QUEUED',
                  scheduled_for: scheduledDate.toISOString(),
                });
              }

              log.info(`Campaign ${campaign.id}: Created ${eligibleCustomers.length} campaign calls`);
            }
          }

          // Update campaign run times
          const nextRunDate = new Date(now.getTime() + (campaign.cycle_frequency_days || 30) * 24 * 60 * 60 * 1000);
          await supabase
            .from('b2b_campaigns')
            .update({
              last_run_at: now.toISOString(),
              next_run_at: nextRunDate.toISOString(),
            })
            .eq('id', campaign.id);
        }

      } catch (campaignError) {
        log.error(`Campaign scheduler: Error processing campaign ${campaign.id}`, campaignError);
      }
    }

  } catch (err) {
    log.error('Campaign scheduler: Unexpected error', err);
  } finally {
    campaignSchedulerRunning = false;
  }
}

export function startCampaignScheduler() {
  log.info('Starting campaign scheduler (interval: 5m)');

  // Run 10 seconds after startup
  setTimeout(() => runCampaignScheduler(), 10000);

  // Then run every 5 minutes
  setInterval(runCampaignScheduler, CAMPAIGN_SCHEDULER_INTERVAL_MS);
}
