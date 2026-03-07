-- 0006_trial_ends_at.sql
-- Add trial expiry tracking to b2b_businesses

-- Add trial_ends_at column with 14-day default for new signups
ALTER TABLE b2b_businesses
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (timezone('utc', now()) + interval '14 days');

-- Track which trial reminder email was last sent
ALTER TABLE b2b_businesses
  ADD COLUMN IF NOT EXISTS last_trial_email_sent TEXT;

-- Backfill: give existing TRIALING users 14 days from now
UPDATE b2b_businesses
  SET trial_ends_at = timezone('utc', now()) + interval '14 days'
  WHERE subscription_status = 'TRIALING'
    AND trial_ends_at IS NULL;

-- Clear trial_ends_at for users who already paid
UPDATE b2b_businesses
  SET trial_ends_at = NULL
  WHERE subscription_status = 'ACTIVE';
