-- Nemo B2B Database Schema and RLS Policies
-- Run this in Supabase SQL Editor or via migrations

-- ============================================
-- TABLES
-- ============================================

-- Businesses (the companies using Nemo B2B)
CREATE TABLE IF NOT EXISTS b2b_businesses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  voice_preference TEXT DEFAULT 'Aoede',
  category TEXT DEFAULT 'OTHER',
  timezone TEXT DEFAULT 'America/Los_Angeles',
  subscription_tier TEXT DEFAULT 'FREE' CHECK (subscription_tier IN ('FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE')),
  subscription_status TEXT DEFAULT 'ACTIVE' CHECK (subscription_status IN ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers (people the business calls)
CREATE TABLE IF NOT EXISTS b2b_customers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  timezone TEXT DEFAULT NULL,
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Appointments (scheduled events to remind about)
CREATE TABLE IF NOT EXISTS b2b_appointments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title TEXT NOT NULL,
  description TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_min INTEGER DEFAULT 30,
  reminder_enabled BOOLEAN DEFAULT true,
  reminder_minutes_before INTEGER DEFAULT 30,
  status TEXT DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'REMINDED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'COMPLETED', 'NO_SHOW')),
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES b2b_customers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Call Logs (record of AI calls made)
CREATE TABLE IF NOT EXISTS b2b_call_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  call_type TEXT NOT NULL CHECK (call_type IN ('REMINDER', 'TEST', 'FOLLOW_UP', 'CONFIRMATION')),
  call_outcome TEXT CHECK (call_outcome IN ('ANSWERED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'FAILED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED')),
  duration_sec INTEGER,
  room_name TEXT,
  sip_call_id TEXT,
  transcript JSONB,
  summary TEXT,
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES b2b_customers(id) ON DELETE SET NULL,
  appointment_id TEXT REFERENCES b2b_appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_b2b_customers_business ON b2b_customers(business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_appointments_business ON b2b_appointments(business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_appointments_customer ON b2b_appointments(customer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_appointments_scheduled ON b2b_appointments(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_b2b_call_logs_business ON b2b_call_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_call_logs_appointment ON b2b_call_logs(appointment_id);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE b2b_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_call_logs ENABLE ROW LEVEL SECURITY;

-- ============================================
-- BUSINESSES POLICIES
-- ============================================

-- Users can view their own businesses
CREATE POLICY "Users can view own businesses" ON b2b_businesses
  FOR SELECT USING (owner_id = auth.uid()::text);

-- Users can create businesses (they become the owner)
CREATE POLICY "Users can create businesses" ON b2b_businesses
  FOR INSERT WITH CHECK (owner_id = auth.uid()::text);

-- Users can update their own businesses
CREATE POLICY "Users can update own businesses" ON b2b_businesses
  FOR UPDATE USING (owner_id = auth.uid()::text);

-- Users can delete their own businesses
CREATE POLICY "Users can delete own businesses" ON b2b_businesses
  FOR DELETE USING (owner_id = auth.uid()::text);

-- ============================================
-- CUSTOMERS POLICIES
-- ============================================

-- Users can view customers of their businesses
CREATE POLICY "Users can view own customers" ON b2b_customers
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can create customers for their businesses
CREATE POLICY "Users can create customers" ON b2b_customers
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can update customers of their businesses
CREATE POLICY "Users can update own customers" ON b2b_customers
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can delete customers of their businesses
CREATE POLICY "Users can delete own customers" ON b2b_customers
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- APPOINTMENTS POLICIES
-- ============================================

-- Users can view appointments of their businesses
CREATE POLICY "Users can view own appointments" ON b2b_appointments
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can create appointments for their businesses
CREATE POLICY "Users can create appointments" ON b2b_appointments
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can update appointments of their businesses
CREATE POLICY "Users can update own appointments" ON b2b_appointments
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can delete appointments of their businesses
CREATE POLICY "Users can delete own appointments" ON b2b_appointments
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- CALL LOGS POLICIES
-- ============================================

-- Users can view call logs of their businesses
CREATE POLICY "Users can view own call logs" ON b2b_call_logs
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Users can create call logs for their businesses
CREATE POLICY "Users can create call logs" ON b2b_call_logs
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- SERVICE ROLE BYPASS (for API server)
-- ============================================
-- Note: The API server uses the service_role key which bypasses RLS
-- This is intentional - the API handles auth and business logic

-- ============================================
-- TRIGGERS FOR updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_b2b_businesses_updated_at
  BEFORE UPDATE ON b2b_businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_b2b_customers_updated_at
  BEFORE UPDATE ON b2b_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_b2b_appointments_updated_at
  BEFORE UPDATE ON b2b_appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- AUTO-CREATE BUSINESS ON SIGNUP
-- ============================================
-- This trigger creates a default business when a user signs up

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO b2b_businesses (owner_id, name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'business_name', 'My Business'));
  RETURN NEW;
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================
-- IDEMPOTENT COLUMN ADDITIONS (for existing databases)
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'timezone'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN timezone TEXT DEFAULT 'America/Los_Angeles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_customers' AND column_name = 'timezone'
  ) THEN
    ALTER TABLE b2b_customers ADD COLUMN timezone TEXT DEFAULT NULL;
  END IF;

  -- Rename reminder_hours → reminder_minutes_before (for existing databases)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_appointments' AND column_name = 'reminder_hours'
  ) THEN
    ALTER TABLE b2b_appointments RENAME COLUMN reminder_hours TO reminder_minutes_before;
    ALTER TABLE b2b_appointments ALTER COLUMN reminder_minutes_before SET DEFAULT 30;
  END IF;

  -- Add duration_min if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_appointments' AND column_name = 'duration_min'
  ) THEN
    ALTER TABLE b2b_appointments ADD COLUMN duration_min INTEGER DEFAULT 30;
  END IF;

  -- Add category to businesses if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_businesses' AND column_name = 'category'
  ) THEN
    ALTER TABLE b2b_businesses ADD COLUMN category TEXT DEFAULT 'OTHER';
  END IF;
END $$;

-- Drop old status CHECK constraint and re-create with REMINDED included
DO $$
BEGIN
  -- Find and drop the existing check constraint on status
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'b2b_appointments' AND column_name = 'status'
  ) THEN
    -- Drop all check constraints on the status column
    EXECUTE (
      SELECT string_agg('ALTER TABLE b2b_appointments DROP CONSTRAINT ' || quote_ident(con.conname), '; ')
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
      WHERE con.conrelid = 'b2b_appointments'::regclass
        AND att.attname = 'status'
        AND con.contype = 'c'
    );
  END IF;

  -- Re-create with REMINDED included
  ALTER TABLE b2b_appointments
    ADD CONSTRAINT b2b_appointments_status_check
    CHECK (status IN ('SCHEDULED', 'REMINDED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'COMPLETED', 'NO_SHOW'));
END $$;
