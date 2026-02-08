/**
 * Determines whether a reminder call should be triggered for a given appointment.
 *
 * The core logic:
 * 1. Calculate `reminderTime` = scheduled_at - reminder_hours (default 24h).
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
  reminder_hours?: number | null;
}

export function shouldTriggerReminder(
  appointment: AppointmentForReminder,
  now: Date,
): boolean {
  const scheduledAt = new Date(appointment.scheduled_at);
  const reminderMinutes = (appointment.reminder_hours ?? 24) * 60;
  const reminderTime = new Date(scheduledAt.getTime() - reminderMinutes * 60 * 1000);

  // Skip if the appointment was created after its reminder window opened.
  const createdAt = new Date(appointment.created_at);
  if (createdAt > reminderTime) {
    return false;
  }

  return reminderTime <= now;
}
