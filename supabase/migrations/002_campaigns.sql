-- Nemo B2B Automated Campaigns Schema
-- Migration: Add campaigns, campaign calls, and campaign templates

-- ============================================
-- ENUM UPDATES: Add new call types and outcomes
-- ============================================

-- Add new CallType values for campaigns
DO $$
BEGIN
  -- Check and add RE_ENGAGEMENT
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'RE_ENGAGEMENT' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallType')) THEN
    ALTER TYPE "CallType" ADD VALUE 'RE_ENGAGEMENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'REVIEW_COLLECTION' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallType')) THEN
    ALTER TYPE "CallType" ADD VALUE 'REVIEW_COLLECTION';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'NO_SHOW_FOLLOWUP' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallType')) THEN
    ALTER TYPE "CallType" ADD VALUE 'NO_SHOW_FOLLOWUP';
  END IF;
END $$;

-- Add new CallOutcome values for campaigns
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'BOOKED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallOutcome')) THEN
    ALTER TYPE "CallOutcome" ADD VALUE 'BOOKED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'REVIEW_SENT' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallOutcome')) THEN
    ALTER TYPE "CallOutcome" ADD VALUE 'REVIEW_SENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DECLINED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CallOutcome')) THEN
    ALTER TYPE "CallOutcome" ADD VALUE 'DECLINED';
  END IF;
END $$;

-- Create CampaignType enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CampaignType') THEN
    CREATE TYPE "CampaignType" AS ENUM ('RE_ENGAGEMENT', 'REVIEW_COLLECTION', 'NO_SHOW_FOLLOWUP');
  END IF;
END $$;

-- Create CampaignCallStatus enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CampaignCallStatus') THEN
    CREATE TYPE "CampaignCallStatus" AS ENUM ('PENDING', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'FAILED');
  END IF;
END $$;

-- ============================================
-- NEW TABLES
-- ============================================

-- Campaigns (automated outbound call campaign definitions)
CREATE TABLE IF NOT EXISTS b2b_campaigns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  campaign_type "CampaignType" NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  settings JSONB DEFAULT '{}',
  call_window_start TEXT DEFAULT '09:00',
  call_window_end TEXT DEFAULT '17:00',
  allowed_days TEXT DEFAULT 'MON,TUE,WED,THU,FRI',
  max_concurrent_calls INTEGER DEFAULT 2,
  min_minutes_between_calls INTEGER DEFAULT 5,
  cycle_frequency_days INTEGER DEFAULT 30,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, campaign_type)
);

-- Campaign Calls (individual customer outreach tracking)
CREATE TABLE IF NOT EXISTS b2b_campaign_calls (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_id TEXT NOT NULL REFERENCES b2b_campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES b2b_customers(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES b2b_businesses(id) ON DELETE CASCADE,
  status "CampaignCallStatus" DEFAULT 'PENDING',
  skip_reason TEXT,
  result_data JSONB,
  scheduled_for TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Campaign Templates (campaign-specific call scripts per business category)
CREATE TABLE IF NOT EXISTS b2b_campaign_templates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  campaign_type "CampaignType" NOT NULL,
  business_category "BusinessCategory" NOT NULL,
  system_prompt TEXT NOT NULL,
  greeting TEXT NOT NULL,
  goal_prompt TEXT NOT NULL,
  closing TEXT NOT NULL,
  voicemail TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_type, business_category)
);

-- ============================================
-- ADD campaign_call_id FK TO CALL LOGS
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'b2b_call_logs' AND column_name = 'campaign_call_id'
  ) THEN
    ALTER TABLE b2b_call_logs ADD COLUMN campaign_call_id TEXT REFERENCES b2b_campaign_calls(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_b2b_campaigns_business ON b2b_campaigns(business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_campaigns_enabled ON b2b_campaigns(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_b2b_campaigns_next_run ON b2b_campaigns(next_run_at) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_b2b_campaign_calls_campaign ON b2b_campaign_calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_b2b_campaign_calls_customer ON b2b_campaign_calls(customer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_campaign_calls_business ON b2b_campaign_calls(business_id);
CREATE INDEX IF NOT EXISTS idx_b2b_campaign_calls_status ON b2b_campaign_calls(status);
CREATE INDEX IF NOT EXISTS idx_b2b_campaign_calls_scheduled ON b2b_campaign_calls(scheduled_for) WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS idx_b2b_campaign_templates_type ON b2b_campaign_templates(campaign_type);
CREATE INDEX IF NOT EXISTS idx_b2b_campaign_templates_lookup ON b2b_campaign_templates(campaign_type, business_category);

CREATE INDEX IF NOT EXISTS idx_b2b_call_logs_campaign_call ON b2b_call_logs(campaign_call_id) WHERE campaign_call_id IS NOT NULL;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE b2b_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_campaign_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_campaign_templates ENABLE ROW LEVEL SECURITY;

-- Campaigns: business owner CRUD
CREATE POLICY "Users can view own campaigns" ON b2b_campaigns
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can create campaigns" ON b2b_campaigns
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can update own campaigns" ON b2b_campaigns
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can delete own campaigns" ON b2b_campaigns
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Campaign Calls: business owner CRUD
CREATE POLICY "Users can view own campaign calls" ON b2b_campaign_calls
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can create campaign calls" ON b2b_campaign_calls
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can update own campaign calls" ON b2b_campaign_calls
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can delete own campaign calls" ON b2b_campaign_calls
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- Campaign Templates: public read (global defaults)
CREATE POLICY "Anyone can view campaign templates" ON b2b_campaign_templates
  FOR SELECT USING (true);

-- Only service role can insert/update/delete templates (via API)
-- No INSERT/UPDATE/DELETE policies needed for regular users

-- ============================================
-- TRIGGERS FOR updated_at
-- ============================================

CREATE TRIGGER update_b2b_campaigns_updated_at
  BEFORE UPDATE ON b2b_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_b2b_campaign_calls_updated_at
  BEFORE UPDATE ON b2b_campaign_calls
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_b2b_campaign_templates_updated_at
  BEFORE UPDATE ON b2b_campaign_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
