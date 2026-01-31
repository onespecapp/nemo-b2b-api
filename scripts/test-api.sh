#!/bin/bash

# Nemo B2B API Test Script
# Usage: ./test-api.sh [API_URL]

API_URL="${1:-http://localhost:6001}"

echo "🧪 Testing Nemo B2B API at: $API_URL"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0

test_endpoint() {
  local name="$1"
  local method="$2"
  local endpoint="$3"
  local data="$4"
  local expected_status="$5"
  
  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" "$API_URL$endpoint")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$API_URL$endpoint" \
      -H "Content-Type: application/json" \
      -d "$data")
  fi
  
  status_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$status_code" = "$expected_status" ]; then
    echo -e "${GREEN}✓${NC} $name (HTTP $status_code)"
    ((PASSED++))
  else
    echo -e "${RED}✗${NC} $name (Expected $expected_status, got $status_code)"
    echo "  Response: $body"
    ((FAILED++))
  fi
}

echo "📋 Running API Tests..."
echo ""

# Health Check
test_endpoint "Health check" "GET" "/health" "" "200"

# Get pending reminders
test_endpoint "Get pending reminders" "GET" "/api/appointments/pending-reminders" "" "200"

# Get call logs (should fail without business_id)
test_endpoint "Call logs without business_id (should fail)" "GET" "/api/call-logs" "" "400"

# Test call without phone (should fail)
test_endpoint "Test call without phone (should fail)" "POST" "/api/test-call" '{}' "400"

# Test call with invalid phone (should fail)
test_endpoint "Test call with invalid phone (should fail)" "POST" "/api/test-call" '{"phone":"invalid"}' "400"

# 404 test
test_endpoint "Non-existent endpoint (should 404)" "GET" "/api/nonexistent" "" "404"

echo ""
echo "=================================="
echo "Results: $PASSED passed, $FAILED failed"

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All tests passed! ✓${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed ✗${NC}"
  exit 1
fi
