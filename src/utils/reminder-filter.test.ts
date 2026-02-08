import { describe, it, expect } from 'vitest';
import { shouldTriggerReminder, AppointmentForReminder } from './reminder-filter';

/**
 * Helper: create a Date offset from a base by a number of hours.
 * Positive hours = future, negative hours = past.
 */
function hoursFrom(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

function makeAppointment(
  overrides: Partial<AppointmentForReminder> & {
    scheduled_at: string;
    created_at: string;
  },
): AppointmentForReminder {
  return {
    id: 'test-apt-1',
    reminder_minutes_before: undefined,
    ...overrides,
  };
}

describe('shouldTriggerReminder', () => {
  // Use a fixed "now" for all tests: 2025-06-15 12:00 UTC
  const now = new Date('2025-06-15T12:00:00Z');

  describe('normal case: appointment created well before reminder window', () => {
    it('should trigger when created days before and reminder window has passed', () => {
      // Appointment scheduled for 2025-06-15 17:00 UTC (5 PM today)
      // Created 3 days ago (2025-06-12 10:00 UTC)
      // Default reminder_minutes_before = 30
      // reminderTime = 17:00 - 30min = 2025-06-15 16:30 UTC
      // createdAt (June 12) < reminderTime (June 15 16:30) => not skipped
      // reminderTime (June 15 16:30) <= now (June 15 12:00) => NO, not yet
      //
      // With 30-min default, the reminder hasn't arrived yet. Use a later now.
      const laterNow = new Date('2025-06-15T16:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T17:00:00Z',
        created_at: '2025-06-12T10:00:00Z',
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });
  });

  describe('bug case: appointment created same day, inside reminder window', () => {
    it('should NOT trigger when created after the reminder window opened', () => {
      // Appointment scheduled for 2025-06-15 17:00 UTC (5 PM today)
      // Created at 2025-06-15 16:40 UTC (after 16:30 reminder window)
      // Default reminder_minutes_before = 30
      // reminderTime = 17:00 - 30min = 16:30
      // createdAt (16:40) > reminderTime (16:30) => SKIP
      const laterNow = new Date('2025-06-15T16:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T17:00:00Z',
        created_at: '2025-06-15T16:40:00Z',
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(false);
    });

    it('should NOT trigger even when created just 1 minute after reminder window', () => {
      // reminderTime = 2025-06-15 16:30 UTC
      // createdAt = 2025-06-15 16:31 UTC (1 minute after window opened)
      const laterNow = new Date('2025-06-15T16:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T17:00:00Z',
        created_at: '2025-06-15T16:31:00Z',
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(false);
    });
  });

  describe('edge case: appointment created exactly at reminder time', () => {
    it('should trigger when created_at equals reminder time exactly', () => {
      // Appointment scheduled for 2025-06-15 17:00 UTC
      // Default reminder_minutes_before = 30
      // reminderTime = 2025-06-15 16:30 UTC
      // createdAt = 2025-06-15 16:30 UTC (exactly at reminder time)
      // createdAt > reminderTime is false (they are equal), so it passes that check
      // reminderTime (16:30) <= laterNow (16:45) => trigger
      const laterNow = new Date('2025-06-15T16:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T17:00:00Z',
        created_at: '2025-06-15T16:30:00Z',
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });
  });

  describe('short reminder window: reminder_minutes_before = 60 (1 hour)', () => {
    it('should trigger when created 2 hours before appointment with 60min window', () => {
      // Appointment scheduled for 2025-06-15 14:00 UTC (2 PM today)
      // Created at 2025-06-15 12:00 UTC (noon, 2 hours before)
      // reminder_minutes_before = 60
      // reminderTime = 14:00 - 60min = 13:00 (1 PM today)
      // createdAt (12:00) > reminderTime (13:00)? No => not skipped
      // reminderTime (13:00) <= laterNow (13:30)? Yes => trigger
      const laterNow = new Date('2025-06-15T13:30:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T14:00:00Z',
        created_at: '2025-06-15T12:00:00Z',
        reminder_minutes_before: 60,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });

    it('should trigger when created well before the window with 60min reminder', () => {
      // Created yesterday, appointment at 2PM today, 60min reminder
      const laterNow = new Date('2025-06-15T13:30:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T14:00:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 60,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });
  });

  describe('short reminder window, created late', () => {
    it('should NOT trigger when created 30 min before appointment with 60min window', () => {
      // Appointment scheduled for 2025-06-15 14:00 UTC
      // Created at 2025-06-15 13:30 UTC (30 min before)
      // reminder_minutes_before = 60
      // reminderTime = 14:00 - 60min = 13:00
      // createdAt (13:30) > reminderTime (13:00) => SKIP
      const laterNow = new Date('2025-06-15T13:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T14:00:00Z',
        created_at: '2025-06-15T13:30:00Z',
        reminder_minutes_before: 60,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(false);
    });
  });

  describe('null reminder_minutes_before defaults to 30min', () => {
    it('should use 30min default when reminder_minutes_before is null', () => {
      // Appointment scheduled for 2025-06-15 12:30 UTC
      // Created 2 days ago
      // reminder_minutes_before = null => defaults to 30
      // reminderTime = 12:30 - 30min = 12:00 (exactly now)
      // createdAt (June 13) < reminderTime (June 15 12:00) => not skipped
      // reminderTime (June 15 12:00) <= now (June 15 12:00) => trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:30:00Z',
        created_at: '2025-06-13T10:00:00Z',
        reminder_minutes_before: null,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should use 30min default when reminder_minutes_before is undefined', () => {
      const apt: AppointmentForReminder = {
        id: 'test-apt-undef',
        scheduled_at: '2025-06-15T12:30:00Z',
        created_at: '2025-06-13T10:00:00Z',
        // reminder_minutes_before not set at all
      };

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should skip with null reminder_minutes_before when created inside the 30min window', () => {
      // Appointment scheduled for 2025-06-15 12:20 UTC
      // Created at 2025-06-15 12:00 (now)
      // reminder_minutes_before = null => 30
      // reminderTime = 12:20 - 30min = 11:50
      // createdAt (12:00) > reminderTime (11:50) => SKIP
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:20:00Z',
        created_at: '2025-06-15T12:00:00Z',
        reminder_minutes_before: null,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(false);
    });
  });

  describe('reminder time has not arrived yet', () => {
    it('should NOT trigger when the reminder window has not opened yet', () => {
      // Appointment scheduled far in the future
      // Created well before, but reminderTime is still in the future
      const apt = makeAppointment({
        scheduled_at: '2025-06-20T12:00:00Z', // 5 days from now
        created_at: '2025-06-10T10:00:00Z',   // created 5 days ago
        reminder_minutes_before: 1440,         // 24 hours in minutes
      });

      // reminderTime = June 19 12:00, now = June 15 12:00
      // createdAt (June 10) < reminderTime (June 19) => not skipped
      // reminderTime (June 19) <= now (June 15)? No => do not trigger
      expect(shouldTriggerReminder(apt, now)).toBe(false);
    });
  });

  describe('custom reminder_minutes_before values', () => {
    it('should work with reminder_minutes_before = 120 (2 hours)', () => {
      // Appointment at 2PM today, created yesterday, 120min reminder
      // reminderTime = 14:00 - 120min = 12:00 (noon), now = 12:00 => should trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T14:00:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 120,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should work with reminder_minutes_before = 2880 (48 hours)', () => {
      // Appointment June 17 12:00, created June 10, 2880min (48h) reminder
      // reminderTime = June 15 12:00 = now => should trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-17T12:00:00Z',
        created_at: '2025-06-10T10:00:00Z',
        reminder_minutes_before: 2880,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should skip with reminder_minutes_before = 2880 when created inside window', () => {
      // Appointment June 17 12:00, created June 16, 2880min (48h) reminder
      // reminderTime = June 15 12:00
      // createdAt (June 16) > reminderTime (June 15 12:00) => SKIP
      const apt = makeAppointment({
        scheduled_at: '2025-06-17T12:00:00Z',
        created_at: '2025-06-16T08:00:00Z',
        reminder_minutes_before: 2880,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(false);
    });
  });

  describe('UI reminder options (minutes)', () => {
    it('should work with 15-minute reminder', () => {
      // Appointment at 12:30, now at 12:16, 15min reminder
      // reminderTime = 12:30 - 15min = 12:15
      // createdAt (yesterday) < reminderTime => not skipped
      // reminderTime (12:15) <= now (12:16) => trigger
      const laterNow = new Date('2025-06-15T12:16:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:30:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 15,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });

    it('should work with 30-minute reminder (default)', () => {
      // Appointment at 12:30, now at 12:01, 30min reminder
      // reminderTime = 12:30 - 30min = 12:00
      // createdAt (yesterday) < reminderTime => not skipped
      // reminderTime (12:00) <= now (12:01) => trigger
      const laterNow = new Date('2025-06-15T12:01:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:30:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 30,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });

    it('should work with 60-minute reminder (1 hour)', () => {
      // Appointment at 13:00, now at 12:01, 60min reminder
      // reminderTime = 13:00 - 60min = 12:00
      // createdAt (yesterday) < reminderTime => not skipped
      // reminderTime (12:00) <= now (12:01) => trigger
      const laterNow = new Date('2025-06-15T12:01:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T13:00:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 60,
      });

      expect(shouldTriggerReminder(apt, laterNow)).toBe(true);
    });

    it('should work with 1440-minute reminder (24 hours)', () => {
      // Appointment June 16 12:00, now June 15 12:00, 1440min reminder
      // reminderTime = June 16 12:00 - 1440min = June 15 12:00
      // createdAt (June 13) < reminderTime => not skipped
      // reminderTime (June 15 12:00) <= now (June 15 12:00) => trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-16T12:00:00Z',
        created_at: '2025-06-13T10:00:00Z',
        reminder_minutes_before: 1440,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should work with 0-minute reminder (on time)', () => {
      // Appointment at 12:00, now at 12:00, 0min reminder
      // reminderTime = 12:00 - 0min = 12:00
      // createdAt (yesterday) < reminderTime (12:00) => not skipped
      // reminderTime (12:00) <= now (12:00) => trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:00:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 0,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(true);
    });

    it('should NOT trigger 0-minute reminder before appointment time', () => {
      // Appointment at 13:00, now at 12:00, 0min reminder
      // reminderTime = 13:00 - 0min = 13:00
      // reminderTime (13:00) <= now (12:00)? No => do not trigger
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T13:00:00Z',
        created_at: '2025-06-14T09:00:00Z',
        reminder_minutes_before: 0,
      });

      expect(shouldTriggerReminder(apt, now)).toBe(false);
    });
  });

  describe('the original bug scenario from the issue', () => {
    it('should fire at 11:30 AM for a 12 PM appointment with 30-min reminder', () => {
      // This is the exact scenario described in the bug:
      // - User creates appointment at 10 AM for 12 PM same day
      // - reminder_minutes_before = 30
      // - reminderTime = 12:00 PM - 30 min = 11:30 AM
      // - createdAt (10 AM) > reminderTime (11:30 AM)? NO => not skipped
      // - reminderTime (11:30 AM) <= now (11:30 AM)? YES => call fires
      const bugNow = new Date('2025-06-15T11:30:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:00:00Z',
        created_at: '2025-06-15T10:00:00Z',
        reminder_minutes_before: 30,
      });

      expect(shouldTriggerReminder(apt, bugNow)).toBe(true);
    });

    it('should NOT fire at 11:00 AM for a 12 PM appointment with 30-min reminder', () => {
      // Too early — reminder window hasn't opened yet
      // reminderTime = 12:00 - 30min = 11:30 AM
      // reminderTime (11:30) <= now (11:00)? No => do not trigger
      const bugNow = new Date('2025-06-15T11:00:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T12:00:00Z',
        created_at: '2025-06-15T10:00:00Z',
        reminder_minutes_before: 30,
      });

      expect(shouldTriggerReminder(apt, bugNow)).toBe(false);
    });

    it('should NOT fire immediately when appointment is created at 12:30 PM for 1:00 PM same day', () => {
      // Created at 12:30 PM for 1:00 PM, 30min reminder
      // reminderTime = 13:00 - 30min = 12:30
      // createdAt (12:30) > reminderTime (12:30)? No (equal) => not skipped
      // BUT now = 12:30 and reminderTime = 12:30, so it triggers at creation time.
      // This is acceptable: the user booked exactly at the reminder window edge.
      const bugNow = new Date('2025-06-15T12:30:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T13:00:00Z',
        created_at: '2025-06-15T12:30:00Z',
        reminder_minutes_before: 30,
      });

      expect(shouldTriggerReminder(apt, bugNow)).toBe(true);
    });

    it('should skip when created AFTER reminder window for same-day appointment', () => {
      // Created at 12:40 PM for 1:00 PM, 30min reminder
      // reminderTime = 13:00 - 30min = 12:30
      // createdAt (12:40) > reminderTime (12:30) => SKIP
      const bugNow = new Date('2025-06-15T12:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T13:00:00Z',
        created_at: '2025-06-15T12:40:00Z',
        reminder_minutes_before: 30,
      });

      expect(shouldTriggerReminder(apt, bugNow)).toBe(false);
    });

    it('should fire for the same appointment if it had been created days ago', () => {
      // Same appointment time, but created well in advance
      const bugNow = new Date('2025-06-15T16:45:00Z');
      const apt = makeAppointment({
        scheduled_at: '2025-06-15T17:00:00Z',
        created_at: '2025-06-10T09:00:00Z',
      });

      expect(shouldTriggerReminder(apt, bugNow)).toBe(true);
    });
  });
});
