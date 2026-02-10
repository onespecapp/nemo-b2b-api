#!/bin/bash

# ===========================================
# Nemo B2B - Dev Environment Setup Script
# ===========================================
# Sets up the dev database (Supabase project: jzggcpoufqtlxmmkojht)
#
# Prerequisites:
#   1. Copy .env.dev.example to .env and fill in real values
#   2. npm install
#
# Usage: ./scripts/setup-dev.sh

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}=== Nemo B2B Dev Environment Setup ===${NC}"
echo ""

# Check we're in the right directory
if [ ! -f "prisma/schema.prisma" ]; then
  echo -e "${RED}Error: Run this script from the nemo-b2b-api root directory${NC}"
  exit 1
fi

# Check .env exists
if [ ! -f ".env" ]; then
  echo -e "${RED}Error: .env file not found${NC}"
  echo -e "Copy .env.dev.example to .env and fill in your dev values:"
  echo -e "  cp .env.dev.example .env"
  exit 1
fi

# Verify it's pointing to dev Supabase (not prod)
if grep -q "dymbjqxrkttwlqwnsyhd" .env; then
  echo -e "${RED}Error: Your .env is pointing to the PRODUCTION Supabase project!${NC}"
  echo -e "For dev setup, use the dev project: ${YELLOW}jzggcpoufqtlxmmkojht${NC}"
  echo -e "Copy .env.dev.example to .env and fill in dev values."
  exit 1
fi

if ! grep -q "jzggcpoufqtlxmmkojht" .env; then
  echo -e "${YELLOW}Warning: Your .env doesn't reference the dev Supabase project (jzggcpoufqtlxmmkojht)${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Step 1: Install dependencies
echo -e "${CYAN}Step 1: Checking dependencies...${NC}"
if [ ! -d "node_modules" ]; then
  echo "Installing npm dependencies..."
  npm install
else
  echo "Dependencies already installed."
fi

# Step 2: Generate Prisma client
echo ""
echo -e "${CYAN}Step 2: Generating Prisma client...${NC}"
npx prisma generate

# Step 3: Push schema to dev database
echo ""
echo -e "${CYAN}Step 3: Pushing Prisma schema to dev database...${NC}"
echo "This will create/update all b2b_* tables in the dev Supabase project."
npx prisma db push

echo ""
echo -e "${GREEN}Prisma schema pushed successfully!${NC}"

# Step 4: Run SQL migrations for RLS, triggers, etc.
echo ""
echo -e "${CYAN}Step 4: Running SQL migrations...${NC}"

# Extract DATABASE_URL from .env (DIRECT_URL for direct connection)
DB_URL=$(grep "^DIRECT_URL=" .env | cut -d'=' -f2- | tr -d '"')
if [ -z "$DB_URL" ]; then
  DB_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2- | tr -d '"')
fi

if [ -n "$DB_URL" ] && command -v psql &> /dev/null; then
  echo "Running 001_create_tables_and_rls.sql (tables, triggers, auto-create trigger)..."
  psql "$DB_URL" -f supabase/migrations/001_create_tables_and_rls.sql 2>&1 | grep -E "^(CREATE|ALTER|DROP|DO|ERROR)" || true

  echo ""
  echo "Running 002_campaigns.sql (campaign tables, triggers)..."
  psql "$DB_URL" -f supabase/migrations/002_campaigns.sql 2>&1 | grep -E "^(CREATE|ALTER|DROP|DO|ERROR)" || true

  echo ""
  echo "Running 001_dev_rls_fix.sql (RLS policies with TEXT cast fix)..."
  psql "$DB_URL" -f supabase/migrations/001_dev_rls_fix.sql 2>&1 | grep -E "^(CREATE|ERROR)" || true

  echo ""
  echo -e "${GREEN}SQL migrations applied!${NC}"
else
  echo -e "${YELLOW}psql not found or DATABASE_URL not set.${NC}"
  echo -e "Run these SQL files manually in ${YELLOW}Supabase Dashboard > SQL Editor${NC}:"
  echo ""
  echo -e "  1. ${CYAN}supabase/migrations/001_create_tables_and_rls.sql${NC}"
  echo -e "     (Tables, triggers, auto-create business on signup)"
  echo ""
  echo -e "  2. ${CYAN}supabase/migrations/002_campaigns.sql${NC}"
  echo -e "     (Campaign tables, triggers)"
  echo ""
  echo -e "  3. ${CYAN}supabase/migrations/001_dev_rls_fix.sql${NC}"
  echo -e "     (RLS policies with TEXT cast fix for Prisma-created tables)"
fi

echo ""
echo -e "${CYAN}=== Remaining Manual Steps ===${NC}"
echo ""
echo -e "  Configure ${YELLOW}Auth > URL Configuration${NC} in Supabase Dashboard:"
echo -e "  - Site URL: your dev Vercel URL or http://localhost:3000"
echo -e "  - Redirect URLs: add dev Vercel URL and http://localhost:3000/**"
echo ""
echo -e "${GREEN}=== Dev DB setup complete! ===${NC}"
echo ""
