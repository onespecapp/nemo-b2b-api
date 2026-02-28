-- ============================================
-- Nemo B2B - AI Receptionist Pivot Migration
-- ============================================
-- This migration adds support for inbound AI receptionist functionality.
-- It adds Telnyx phone line config, receptionist settings, booking settings,
-- caller info on call logs, a new messages table, and new enum values
-- for inbound call types, outcomes, and trades business categories.
--
-- Designed to be idempotent (safe to run multiple times).

-- ============================================
-- 1. ENUM UPDATES: Add new values
-- ============================================

-- Add INBOUND to CallType
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'INBOUND' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallType')) THEN
    ALTER TYPE "CallType" ADD VALUE 'INBOUND';
  END IF;
END $$;

-- Add MESSAGE_TAKEN to CallOutcome
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MESSAGE_TAKEN' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallOutcome')) THEN
    ALTER TYPE "CallOutcome" ADD VALUE 'MESSAGE_TAKEN';
  END IF;
END $$;

-- Add TRANSFERRED to CallOutcome
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'TRANSFERRED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallOutcome')) THEN
    ALTER TYPE "CallOutcome" ADD VALUE 'TRANSFERRED';
  END IF;
END $$;

-- Add new trades BusinessCategory values
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'PLUMBING' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'PLUMBING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'HVAC' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'HVAC';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ELECTRICAL' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'ELECTRICAL';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'GENERAL_CONTRACTOR' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'GENERAL_CONTRACTOR';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'LANDSCAPING' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'LANDSCAPING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ROOFING' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'ROOFING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'PAINTING' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BusinessCategory')) THEN
    ALTER TYPE "BusinessCategory" ADD VALUE 'PAINTING';
  END IF;
END $$;

-- ============================================
-- 2. ALTER TABLE b2b_businesses: Receptionist columns
-- ============================================

DO $$
BEGIN
  -- Telnyx phone line
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'telnyx_phone_number'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN telnyx_phone_number TEXT UNIQUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'telnyx_connection_id'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN telnyx_connection_id TEXT;
  END IF;

  -- AI Receptionist settings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'receptionist_enabled'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN receptionist_enabled BOOLEAN DEFAULT false NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'receptionist_greeting'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN receptionist_greeting TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'receptionist_instructions'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN receptionist_instructions TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'business_hours'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN business_hours JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'services'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN services JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'faqs'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN faqs JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'transfer_phone'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN transfer_phone TEXT;
  END IF;

  -- Booking settings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'booking_enabled'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN booking_enabled BOOLEAN DEFAULT false NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'default_appointment_duration'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN default_appointment_duration INTEGER DEFAULT 60 NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'booking_advance_days'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN booking_advance_days INTEGER DEFAULT 14 NOT NULL;
  END IF;
END $$;

-- ============================================
-- 3. ALTER TABLE b2b_call_logs: Caller info columns
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_call_logs' AND column_name = 'to_number'
  ) THEN
    ALTER TABLE b2b_call_logs ADD COLUMN to_number TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_call_logs' AND column_name = 'from_number'
  ) THEN
    ALTER TABLE b2b_call_logs ADD COLUMN from_number TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_call_logs' AND column_name = 'caller_name'
  ) THEN
    ALTER TABLE b2b_call_logs ADD COLUMN caller_name TEXT;
  END IF;
END $$;

-- ============================================
-- 4. DROP campaign_call_id from b2b_call_logs
-- ============================================

ALTER TABLE b2b_call_logs DROP COLUMN IF EXISTS campaign_call_id;

-- ============================================
-- 5. UPDATE call_type CHECK constraint (if TEXT-based)
-- ============================================
-- The original migration 001 used TEXT + CHECK for call_type/call_outcome.
-- If the database was initialized via SQL migrations (production), we need
-- to update the CHECK constraints to allow new values.
-- If the database was initialized via Prisma (dev), these are enum types
-- and the ALTER TYPE statements above handle it.

DO $$
BEGIN
  -- Update call_type CHECK constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
    WHERE con.conrelid = 'b2b_call_logs'::regclass
      AND att.attname = 'call_type'
      AND con.contype = 'c'
  ) THEN
    -- Drop existing check constraints on call_type
    EXECUTE (
      SELECT string_agg('ALTER TABLE b2b_call_logs DROP CONSTRAINT ' || quote_ident(con.conname), '; ')
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
      WHERE con.conrelid = 'b2b_call_logs'::regclass
        AND att.attname = 'call_type'
        AND con.contype = 'c'
    );

    -- Re-create with all values including INBOUND
    ALTER TABLE b2b_call_logs
      ADD CONSTRAINT b2b_call_logs_call_type_check
      CHECK (call_type IN ('REMINDER', 'TEST', 'FOLLOW_UP', 'CONFIRMATION', 'RE_ENGAGEMENT', 'REVIEW_COLLECTION', 'NO_SHOW_FOLLOWUP', 'INBOUND'));
  END IF;

  -- Update call_outcome CHECK constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
    WHERE con.conrelid = 'b2b_call_logs'::regclass
      AND att.attname = 'call_outcome'
      AND con.contype = 'c'
  ) THEN
    -- Drop existing check constraints on call_outcome
    EXECUTE (
      SELECT string_agg('ALTER TABLE b2b_call_logs DROP CONSTRAINT ' || quote_ident(con.conname), '; ')
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
      WHERE con.conrelid = 'b2b_call_logs'::regclass
        AND att.attname = 'call_outcome'
        AND con.contype = 'c'
    );

    -- Re-create with all values including MESSAGE_TAKEN and TRANSFERRED
    ALTER TABLE b2b_call_logs
      ADD CONSTRAINT b2b_call_logs_call_outcome_check
      CHECK (call_outcome IN ('ANSWERED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'FAILED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'BOOKED', 'REVIEW_SENT', 'DECLINED', 'MESSAGE_TAKEN', 'TRANSFERRED'));
  END IF;
END $$;

-- ============================================
-- 6. CREATE TABLE b2b_messages
-- ============================================

CREATE TABLE IF NOT EXISTS b2b_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  call_log_id TEXT REFERENCES b2b_call_logs(id) ON DELETE SET NULL,
  caller_name TEXT,
  caller_phone TEXT,
  message TEXT NOT NULL,
  reason TEXT,
  urgency TEXT DEFAULT 'normal' NOT NULL,
  read BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ============================================
-- 7. INDEXES
-- ============================================

CREATE UNIQUE INDEX IF NOT EXISTS b2b_businesses_telnyx_phone_number_key
  ON b2b_businesses(telnyx_phone_number);

CREATE INDEX IF NOT EXISTS idx_b2b_messages_business
  ON b2b_messages(business_id);

CREATE INDEX IF NOT EXISTS idx_b2b_messages_unread
  ON b2b_messages(business_id, read) WHERE read = false;

CREATE INDEX IF NOT EXISTS idx_b2b_messages_call_log
  ON b2b_messages(call_log_id) WHERE call_log_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_call_logs_from_number
  ON b2b_call_logs(from_number) WHERE from_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_businesses_receptionist
  ON b2b_businesses(receptionist_enabled) WHERE receptionist_enabled = true;

-- ============================================
-- 8. ROW LEVEL SECURITY for b2b_messages
-- ============================================

ALTER TABLE b2b_messages ENABLE ROW LEVEL SECURITY;

-- Messages: business owner CRUD
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'b2b_messages' AND policyname = 'Users can view own messages'
  ) THEN
    CREATE POLICY "Users can view own messages" ON b2b_messages
      FOR SELECT USING (
        business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'b2b_messages' AND policyname = 'Users can create messages'
  ) THEN
    CREATE POLICY "Users can create messages" ON b2b_messages
      FOR INSERT WITH CHECK (
        business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'b2b_messages' AND policyname = 'Users can update own messages'
  ) THEN
    CREATE POLICY "Users can update own messages" ON b2b_messages
      FOR UPDATE USING (
        business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'b2b_messages' AND policyname = 'Users can delete own messages'
  ) THEN
    CREATE POLICY "Users can delete own messages" ON b2b_messages
      FOR DELETE USING (
        business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
      );
  END IF;
END $$;

-- ============================================
-- 9. TRIGGER for b2b_messages updated_at
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_b2b_messages_updated_at'
  ) THEN
    CREATE TRIGGER update_b2b_messages_updated_at
      BEFORE UPDATE ON b2b_messages
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
