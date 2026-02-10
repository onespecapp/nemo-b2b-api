-- ============================================
-- Dev Database RLS Fix
-- ============================================
-- When Prisma creates tables, owner_id is TEXT (not UUID).
-- auth.uid() returns UUID, so we need explicit ::text casts.
-- Run this INSTEAD of the RLS sections in 001/002 if using Prisma-created tables.
--
-- This is only needed for fresh dev databases initialized with `prisma db push`.
-- Production was initialized with the SQL migrations first, so the original
-- migrations work there.

-- ============================================
-- BUSINESSES POLICIES
-- ============================================

CREATE POLICY "Users can view own businesses" ON b2b_businesses
  FOR SELECT USING (owner_id = auth.uid()::text);

CREATE POLICY "Users can create businesses" ON b2b_businesses
  FOR INSERT WITH CHECK (owner_id = auth.uid()::text);

CREATE POLICY "Users can update own businesses" ON b2b_businesses
  FOR UPDATE USING (owner_id = auth.uid()::text);

CREATE POLICY "Users can delete own businesses" ON b2b_businesses
  FOR DELETE USING (owner_id = auth.uid()::text);

-- ============================================
-- CUSTOMERS POLICIES
-- ============================================

CREATE POLICY "Users can view own customers" ON b2b_customers
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can create customers" ON b2b_customers
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can update own customers" ON b2b_customers
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can delete own customers" ON b2b_customers
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- APPOINTMENTS POLICIES
-- ============================================

CREATE POLICY "Users can view own appointments" ON b2b_appointments
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can create appointments" ON b2b_appointments
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can update own appointments" ON b2b_appointments
  FOR UPDATE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can delete own appointments" ON b2b_appointments
  FOR DELETE USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- CALL LOGS POLICIES
-- ============================================

CREATE POLICY "Users can view own call logs" ON b2b_call_logs
  FOR SELECT USING (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

CREATE POLICY "Users can create call logs" ON b2b_call_logs
  FOR INSERT WITH CHECK (
    business_id IN (SELECT id FROM b2b_businesses WHERE owner_id = auth.uid()::text)
  );

-- ============================================
-- CAMPAIGNS POLICIES
-- ============================================

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

-- ============================================
-- CAMPAIGN CALLS POLICIES
-- ============================================

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

-- ============================================
-- CAMPAIGN TEMPLATES (public read)
-- ============================================

CREATE POLICY "Anyone can view campaign templates" ON b2b_campaign_templates
  FOR SELECT USING (true);
