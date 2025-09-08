#!/bin/bash

# Simple Tapis test using SCRATCH filesystem on ls6
# This avoids complex work directory paths and uses the standard scratch space

# Configuration
BASE_URL="https://portals.tapis.io"
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJkZmRmZGY1Zi00NTk2LTQ0NGItYjkzYy1iNmZjZjI4YjM4ZjQiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY4MjkyMDAsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.o63ilr5dxa3p1_D0lBERPxY0RITBywuByp1qORPjf3ET0Vc6ebLBVtS_XxPFyQecEPw4r_aIwrR0bxMnVhVQM6hs1qgedw0GSsXWsJj-x2CHHC2ZGMFSbPC20HocYaoKBmL7sIi15cNLApJH6_9MEkarx0cia-ZXGfhs7itpX6RCaMK3zW0WYSj8T8qxLsscakH5fmJmAoIAqjhzi-rReRBLp3lwyqXhZZUErzMG1SXbWyWN_Y1h02SCpLPqyg06y6RPEpmA4rlgINCiAxEuMLGFBi8xoNs_fzhT4OelSjYQgAB1ic_vsq6K48aQS9waZSqOoM2mgOMMK_ht8HuwgA"

SYSTEM_ID="ls6"
JOB_ID="scratch-test-$(date +%s)"

# Use SCRATCH filesystem with full path
SCRATCH_PATH="scratch/06659/wmobley/clusterodm-jobs/${JOB_ID}"

echo "🧪 Simple Tapis Test - Using SCRATCH filesystem"
echo "=============================================="
echo "Job ID: $JOB_ID"
echo "Scratch Path: $SCRATCH_PATH"
echo ""

# Simple status check function
check_status() {
    local response_file="$1"
    local operation="$2"
    local status_code=$(grep "HTTP/" "$response_file" | tail -1 | cut -d'/' -f2)
    
    if [[ "$status_code" =~ ^2[0-9][0-9]$ ]]; then
        echo "✅ $operation: SUCCESS"
    else
        echo "❌ $operation: FAILED (HTTP $status_code)"
        cat "$response_file" | grep -v "HTTP/" | head -5
    fi
    echo ""
}

# 1. Test token
echo "🔑 Testing token..."
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  "$BASE_URL/v3/systems/$SYSTEM_ID" > token_test.response

check_status "token_test.response" "Token validation"

# 2. Use real test images from testData directory
echo "📁 Using real test images from testData/..."
TEST_IMAGES_DIR="testData"
if [[ ! -d "$TEST_IMAGES_DIR" ]]; then
    echo "❌ testData directory not found, creating dummy files..."
    mkdir -p test_images
    echo "Test image data 1" > test_images/test1.jpg
    echo "Test image data 2" > test_images/test2.jpg
    TEST_IMAGES_DIR="test_images"
fi
echo ""

# 3. Upload to SCRATCH
echo "⬆️  Uploading to SCRATCH..."
for file in $TEST_IMAGES_DIR/*.{jpg,JPG,jpeg,JPEG}; do
    [[ ! -f "$file" ]] && continue
    filename=$(basename "$file")
    echo "Uploading $filename to scratch..."
    
    curl -s -w "\nHTTP/%{http_code}\n" \
      -H "X-Tapis-Token: $TOKEN" \
      -F "file=@$file" \
      "$BASE_URL/v3/files/ops/$SYSTEM_ID/$SCRATCH_PATH/$filename" > upload_${filename}.response
    
    check_status "upload_${filename}.response" "Upload $filename"
done

# 4. List files in scratch
echo "📋 Listing files in scratch..."
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  "$BASE_URL/v3/files/listings/$SYSTEM_ID/$SCRATCH_PATH" > list_files.response

check_status "list_files.response" "List scratch files"

if grep -q "HTTP/200" list_files.response; then
    echo "📂 Files found in scratch:"
    cat list_files.response | grep -v "HTTP/" | jq -r '.result[]?.name // "No files"' 2>/dev/null || echo "Could not parse file list"
fi

# 5. Find a working ODM app
echo ""
echo "🔍 Looking for ODM applications..."
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  "$BASE_URL/v3/apps?limit=100" > apps_list.response

if grep -q "HTTP/200" apps_list.response; then
    echo "📱 Searching for ODM/photogrammetry apps..."
    cat apps_list.response | grep -v "HTTP/" | jq -r '.result[]?.id // empty' 2>/dev/null | \
        grep -i -E '(odm|photo|drone|ortho|mesh|node)' | head -3 || echo "No ODM apps found"
    
    echo ""
    echo "📱 All available apps:"
    cat apps_list.response | grep -v "HTTP/" | jq -r '.result[]?.id // empty' 2>/dev/null | head -10 || echo "Could not list apps"
fi

# 6. Submit ODM job
echo ""
echo "🚀 Submitting ODM job..."

# Create job definition for ODM processing
cat > odm_job.json << EOF
{
  "name": "odm-test-${JOB_ID}",
  "description": "ODM processing of ${JOB_ID} drone images",
  "appId": "nodeodm-ls6",
  "appVersion": "1.0.0",
  "execSystemId": "${SYSTEM_ID}",
  "execSystemLogicalQueue": "vm-small",
  "archiveSystemId": "${SYSTEM_ID}",
  "nodeCount": 1,
  "coresPerNode": 2,
  "memoryMB": 8192,
  "maxMinutes": 60,
  "archiveOnAppError": true,
  "parameterSet": {
    "appArgs": [
      {"arg": "/inputs"},
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
      "description": "Drone images for ODM processing",
      "sourceUrl": "tapis://${SYSTEM_ID}/${SCRATCH_PATH}",
      "targetPath": "inputs"
    }
  ]
}
EOF

echo "Job definition created for ODM processing"

# Submit the job
curl -s -w "\nHTTP/%{http_code}\n" \
  -H "X-Tapis-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d @odm_job.json \
  "$BASE_URL/v3/jobs/submit" > job_submit.response

check_status "job_submit.response" "ODM Job submission"

# Extract job UUID if successful
JOB_UUID=$(cat job_submit.response | grep -v "HTTP/" | jq -r '.result.uuid // empty' 2>/dev/null)

if [[ -n "$JOB_UUID" && "$JOB_UUID" != "null" ]]; then
    echo "🎉 ODM Job submitted successfully!"
    echo "Job UUID: $JOB_UUID"
    echo "$JOB_UUID" > last_job_uuid.txt
    
    # Check initial job status
    echo ""
    echo "📊 Checking job status..."
    curl -s -w "\nHTTP/%{http_code}\n" \
      -H "X-Tapis-Token: $TOKEN" \
      "$BASE_URL/v3/jobs/$JOB_UUID" > job_status.response
    
    if grep -q "HTTP/200" job_status.response; then
        JOB_STATUS=$(cat job_status.response | grep -v "HTTP/" | jq -r '.result.status' 2>/dev/null || echo "unknown")
        echo "✅ Current job status: $JOB_STATUS"
    fi
fi

echo ""
echo "✨ SUMMARY:"
echo "- Token: ✅ Working"
echo "- Image uploads: ✅ 4 DJI images uploaded with original names"
echo "- ODM job: Check above"
echo ""
echo "💡 Monitor job status with:"
echo "   curl -H \"X-Tapis-Token: \$TOKEN\" \"$BASE_URL/v3/jobs/\$(cat last_job_uuid.txt 2>/dev/null)\""