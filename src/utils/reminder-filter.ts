/**
 * Determines whether a reminder call should be triggered for a given appointment.
 *
 * The core logic:
 * 1. Calculate `reminderTime` = scheduled_at - reminder_minutes_before (default 30 min).
 * 2. If the appointment was created AFTER its reminder window opened
 *    (i.e. created_at > reminderTime), skip it. This prevents immediate
 *    calls when an appointment is booked closer to its scheduled time
 *    than the reminder window.
 * 3. Otherwise, trigger if reminderTime <= now.
 */

export interface AppointmentForReminder {
  id: string;
  scheduled_at: string;   // ISO 8601
  created_at: string;     // ISO 8601
  reminder_minutes_before?: number | null;
}

export function shouldTriggerReminder(
  appointment: AppointmentForReminder,
  now: Date,
): boolean {
  const scheduledAt = new Date(appointment.scheduled_at);
  const reminderMinutes = appointment.reminder_minutes_before ?? 30;
  const reminderTime = new Date(scheduledAt.getTime() - reminderMinutes * 60 * 1000);

  // When reminder_minutes_before is 0, trigger as soon as scheduled_at is reached
  // (bypasses the created-after-window check, useful for testing)
  if (reminderMinutes === 0) {
    return scheduledAt <= now;
  }

  // Skip if the appointment was created after its reminder window opened.
  const createdAt = new Date(appointment.created_at);
  if (createdAt > reminderTime) {
    return false;
  }

  return reminderTime <= now;
}
