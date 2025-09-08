#!/bin/bash

# Tapis debugging script - test data transfer and job submission with curl
# Based on the ClusterODM Tapis configuration

# Configuration from tapis-config.json
BASE_URL="https://portals.tapis.io"
TENANT_ID="portals"
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJkZmRmZGY1Zi00NTk2LTQ0NGItYjkzYy1iNmZjZjI4YjM4ZjQiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY4MjkyMDAsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.o63ilr5dxa3p1_D0lBERPxY0RITBywuByp1qORPjf3ET0Vc6ebLBVtS_XxPFyQecEPw4r_aIwrR0bxMnVhVQM6hs1qgedw0GSsXWsJj-x2CHHC2ZGMFSbPC20HocYaoKBmL7sIi15cNLApJH6_9MEkarx0cia-ZXGfhs7itpX6RCaMK3zW0WYSj8T8qxLsscakH5fmJmAoIAqjhzi-rReRBLp3lwyqXhZZUErzMG1SXbWyWN_Y1h02SCpLPqyg06y6RPEpmA4rlgINCiAxEuMLGFBi8xoNs_fzhT4OelSjYQgAB1ic_vsq6K48aQS9waZSqOoM2mgOMMK_ht8HuwgA"

APP_ID="Whisper-Transcription"
APP_VERSION="0.1.4sha-c2a131d"
EXECUTION_SYSTEM_ID="ls6"
ARCHIVE_SYSTEM_ID="ls6"

# Generate unique job ID for this test
JOB_ID="test-$(date +%s)"
UPLOAD_PATH="work/06659/wmobley/clusterodm/jobs/${JOB_ID}/inputs"

echo "🧪 Tapis Debug Script - ClusterODM Job Submission Test"
echo "======================================================"
echo "Job ID: $JOB_ID"
echo "Upload Path: $UPLOAD_PATH"
echo ""

# Function to check HTTP status and display results
check_response() {
    local response_file="$1"
    local operation="$2"
    local status_code=$(grep "HTTP/" "$response_file" | tail -1 | cut -d'/' -f2)
    
    echo "📊 $operation - Status: HTTP/$status_code"
    
    if [[ "$status_code" =~ ^2[0-9][0-9]$ ]]; then
        echo "✅ $operation successful"
        echo "Response:"
        cat "$response_file" | grep -v "HTTP/" | jq . 2>/dev/null || cat "$response_file" | grep -v "HTTP/"
    else
        echo "❌ $operation failed (HTTP $status_code)"
        echo "Full response:"
        cat "$response_file" | grep -v "HTTP/"
    fi
    echo ""
}

# Step 1: Validate token by listing systems
echo "🔑 Step 1: Validate Tapis token"
echo "--------------------------------"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/systems" > token_test.response

check_response "token_test.response" "Token validation"

# Step 2: List available applications to find correct ODM app
echo "📱 Step 2: List available applications"
echo "-------------------------------------"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/apps" > apps_list.response

check_response "apps_list.response" "List applications"

# Step 2b: Check specific application availability
echo "📱 Step 2b: Check specific application ($APP_ID-$APP_VERSION)"
echo "------------------------------------------------------------"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/apps/$APP_ID-$APP_VERSION" > app_test.response

check_response "app_test.response" "Specific application check"

# Step 3: Create test files to upload
echo "📁 Step 3: Create test files"
echo "----------------------------"
mkdir -p test_images
echo "Test image 1 content" > test_images/image1.jpg
echo "Test image 2 content" > test_images/image2.jpg
echo "Test image 3 content" > test_images/image3.jpg
echo "✅ Created 3 test image files in test_images/"
echo ""

# Step 4: Upload files to Tapis storage
echo "⬆️  Step 4: Upload files to Tapis storage"
echo "------------------------------------------"

# Upload each file
for file in test_images/*.jpg; do
    filename=$(basename "$file")
    echo "Uploading $filename..."
    
    curl -s -w "\nHTTP/%{http_code}\n" \
      -H "X-Tapis-Token: $TOKEN" \
      -F "file=@$file" \
      "$BASE_URL/v3/files/ops/$ARCHIVE_SYSTEM_ID/$UPLOAD_PATH/$filename" > upload_${filename}.response
    
    check_response "upload_${filename}.response" "File upload ($filename)"
done

# Step 5: List uploaded files to verify (try multiple paths)
echo "📋 Step 5: List uploaded files"
echo "------------------------------"

# Try the exact upload path
echo "Trying exact upload path: $UPLOAD_PATH"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/files/listings/$ARCHIVE_SYSTEM_ID/$UPLOAD_PATH" > list_files_exact.response

check_response "list_files_exact.response" "List files (exact path)"

# Try parent directory
PARENT_PATH=$(dirname "$UPLOAD_PATH")
echo "Trying parent path: $PARENT_PATH"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/files/listings/$ARCHIVE_SYSTEM_ID/$PARENT_PATH" > list_files_parent.response

check_response "list_files_parent.response" "List files (parent path)"

# Try root work directory to see structure
echo "Trying work directory root: work/06659/wmobley"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/files/listings/$ARCHIVE_SYSTEM_ID/work/06659/wmobley" > list_files_work.response

check_response "list_files_work.response" "List files (work root)"

# Try to find clusterodm directory
echo "Trying clusterodm directory: work/06659/wmobley/clusterodm"
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v3/files/listings/$ARCHIVE_SYSTEM_ID/work/06659/wmobley/clusterodm" > list_files_clusterodm.response

check_response "list_files_clusterodm.response" "List files (clusterodm)"

# Step 5c: Search for files by name to find actual location
echo ""
echo "🔍 Step 5c: Search for uploaded files by name"
echo "---------------------------------------------"
for filename in image1.jpg image2.jpg image3.jpg; do
    echo "Searching for $filename..."
    # Try a broader search in work directory
    curl -s -w "\nHTTP/%{http_code}\n" \
      -H "X-Tapis-Token: $TOKEN" \
      -H "Content-Type: application/json" \
      "$BASE_URL/v3/files/ops/$ARCHIVE_SYSTEM_ID?op=search&path=work/06659/wmobley&name=$filename" > search_${filename}.response 2>/dev/null || echo "Search not supported, skipping..."
    
    if [[ -f "search_${filename}.response" ]]; then
        check_response "search_${filename}.response" "Search for $filename"
    fi
done

# Step 6: Submit job
echo "🚀 Step 6: Submit Tapis job"
echo "---------------------------"

# Create job definition JSON
cat > job_definition.json << EOF
{
  "name": "clusterodm-${JOB_ID}",
  "description": "ClusterODM ODM processing job for 3 images",
  "appId": "${APP_ID}",
  "appVersion": "${APP_VERSION}",
  "execSystemId": "${EXECUTION_SYSTEM_ID}",
  "execSystemLogicalQueue": "vm-small",
  "archiveSystemId": "${ARCHIVE_SYSTEM_ID}",
  "nodeCount": 1,
  "coresPerNode": 2,
  "memoryMB": 8192,
  "maxMinutes": 120,
  "archiveOnAppError": true,
  "parameterSet": {
    "appArgs": [
      {"arg": "--input"},
      {"arg": "/inputs/${JOB_ID}"},
      {"arg": "--output"},
      {"arg": "/outputs"}
    ],
    "containerArgs": [],
    "schedulerOptions": [
      {"arg": "-A PT2050-DataX"}
    ]
  },
  "fileInputs": [
    {
      "name": "inputImages",
      "description": "Input images for ODM processing",
      "sourceUrl": "tapis://${ARCHIVE_SYSTEM_ID}/${UPLOAD_PATH}"
    }
  ],
  "fileInputArrays": [],
  "subscriptions": []
}
EOF

echo "Job definition created:"
cat job_definition.json | jq .
echo ""

# Submit the job
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d @job_definition.json \
  "$BASE_URL/v3/jobs/submit" > job_submit.response

check_response "job_submit.response" "Job submission"

# Extract job UUID if successful
JOB_UUID=$(cat job_submit.response | grep -v "HTTP/" | jq -r '.result.uuid // empty' 2>/dev/null)

if [[ -n "$JOB_UUID" && "$JOB_UUID" != "null" ]]; then
    echo "🎉 Job submitted successfully!"
    echo "Job UUID: $JOB_UUID"
    echo ""
    
    # Step 7: Check job status
    echo "📊 Step 7: Check job status"
    echo "---------------------------"
    curl -s -w "\nHTTP/%{http_code}\n" \
      -H "X-Tapis-Token: $TOKEN" \
      -H "Content-Type: application/json" \
      "$BASE_URL/v3/jobs/$JOB_UUID" > job_status.response
    
    check_response "job_status.response" "Job status check"
    
    # Save job UUID for future reference
    echo "$JOB_UUID" > last_job_uuid.txt
    echo "💾 Job UUID saved to last_job_uuid.txt for future reference"
else
    echo "❌ Failed to extract job UUID from response"
fi

echo ""
echo "📊 SUMMARY"
echo "=========="

# Extract key findings
echo "🔍 Key Findings:"

# Check if token worked (look for systems in response)
if grep -q "\"result\":\[" token_test.response 2>/dev/null; then
    SYSTEM_COUNT=$(cat token_test.response | grep -v "HTTP/" | jq '.result | length' 2>/dev/null || echo "unknown")
    echo "✅ Token: VALID (found $SYSTEM_COUNT systems)"
else
    echo "❌ Token: INVALID"
fi

# Check apps
if [[ -f "apps_list.response" ]]; then
    APP_COUNT=$(cat apps_list.response | grep -v "HTTP/" | jq '.result | length' 2>/dev/null || echo "unknown")
    echo "📱 Available apps: $APP_COUNT total"
    
    # Look for ODM-related apps
    echo "🔍 Looking for ODM/photogrammetry apps..."
    cat apps_list.response | grep -v "HTTP/" | jq -r '.result[]?.id // empty' 2>/dev/null | grep -i -E '(odm|photo|drone|ortho|mesh)' | head -5 || echo "   No obvious ODM apps found"
fi

# Check uploads
UPLOAD_SUCCESS=0
for file in test_images/*.jpg; do
    filename=$(basename "$file")
    if grep -q "Operation completed" "upload_${filename}.response" 2>/dev/null; then
        ((UPLOAD_SUCCESS++))
    fi
done
echo "📤 File uploads: $UPLOAD_SUCCESS/3 successful"

# Check job submission
if [[ -n "$JOB_UUID" && "$JOB_UUID" != "null" ]]; then
    JOB_STATUS=$(cat job_status.response | grep -v "HTTP/" | jq -r '.result.status' 2>/dev/null || echo "unknown")
    echo "🚀 Job submission: SUCCESS (Status: $JOB_STATUS)"
    echo "   Job UUID: $JOB_UUID"
else
    echo "🚀 Job submission: FAILED"
fi

echo ""
echo "🧹 Files Created:"
echo "- test_images/ (test data)"
echo "- *.response (API responses)"
echo "- job_definition.json (job config)"
echo "- last_job_uuid.txt (job reference)"
echo ""
echo "💡 Next Steps:"
echo "1. If apps list shows ODM apps, update APP_ID in script"
echo "2. Check file paths if uploads succeeded but listing failed"
echo "3. Monitor job status with:"
echo "   curl -H \"X-Tapis-Token: \$TOKEN\" \"$BASE_URL/v3/jobs/\$(cat last_job_uuid.txt 2>/dev/null || echo 'JOB_UUID')\""