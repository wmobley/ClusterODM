#!/bin/bash

# Script to check Tapis jobs
if [ -z "$1" ]; then
    echo "❌ Usage: ./check-tapis-jobs.sh <TAPIS_JWT_TOKEN>"
    exit 1
fi

TOKEN="$1"
BASE_URL="https://portals.tapis.io"
TENANT="portals"

echo "🔍 Checking Tapis jobs..."

# List recent jobs
curl -s -X GET "${BASE_URL}/v3/jobs/list" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-Tapis-Tenant: ${TENANT}" \
  -H "Content-Type: application/json" | \
  jq -r '.result[] | select(.name | contains("clusterodm")) | "\(.uuid) | \(.name) | \(.status) | \(.created)"' | \
  head -10

echo ""
echo "✅ Check complete. Look for jobs with 'clusterodm' in the name."
echo "📊 Full job list: ${BASE_URL}/v3/jobs/list"