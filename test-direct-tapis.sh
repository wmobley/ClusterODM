#!/bin/bash

# Direct Tapis job submission test - confirm output stays on LS6
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJkZmRmZGY1Zi00NTk2LTQ0NGItYjkzYy1iNmZjZjI4YjM4ZjQiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY4MjkyMDAsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.o63ilr5dxa3p1_D0lBERPxY0RITBywuByp1qORPjf3ET0Vc6ebLBVtS_XxPFyQecEPw4r_aIwrR0bxMnVhVQM6hs1qgedw0GSsXWsJj-x2CHHC2ZGMFSbPC20HocYaoKBmL7sIi15cNLApJH6_9MEkarx0cia-ZXGfhs7itpX6RCaMK3zW0WYSj8T8qxLsscakH5fmJmAoIAqjhzi-rReRBLp3lwyqXhZZUErzMG1SXbWyWN_Y1h02SCpLPqyg06y6RPEpmA4rlgINCiAxEuMLGFBi8xoNs_fzhT4OelSjYQgAB1ic_vsq6K48aQS9waZSqOoM2mgOMMK_ht8HuwgA"
BASE_URL="https://portals.tapis.io"
JOB_ID="test-nodeodm-$(date +%Y%m%d-%H%M%S)"

echo "🚀 Testing Direct Tapis Job Submission"
echo "======================================"
echo "Job ID: $JOB_ID"

# Step 1: Create scratch directory and upload test image
echo ""
echo "📁 Step 1: Creating scratch directory and uploading image..."
UPLOAD_PATH="scratch/06659/wmobley/clusterodm/jobs/$JOB_ID/inputs"

# Use exact approach from working simple-tapis-test.sh
echo "📤 Uploading test image with curl -T (PUT method)..."
curl -s -T "testData/small/DJI_20250801034350_0002_D.JPG" \
    -H "X-Tapis-Token: $TOKEN" \
    "$BASE_URL/v3/files/content/ls6/$UPLOAD_PATH/DJI_20250801034350_0002_D.JPG"

echo ""
echo "📋 Verifying upload..."
curl -s -H "X-Tapis-Token: $TOKEN" \
    "$BASE_URL/v3/files/listings/ls6/$UPLOAD_PATH" | jq -r '.result[]?.name // "No files found"' | head -5

# Step 2: Submit NodeODM job
echo ""
echo "🔧 Step 2: Submitting NodeODM job..."

JOB_DEF=$(cat <<EOF
{
  "name": "$JOB_ID",
  "appId": "nodeodm-ls6",
  "appVersion": "1.0.1",
  "execSystemId": "ls6",
  "archiveSystemId": "ls6",
  "archiveSystemDir": "scratch/06659/wmobley/clusterodm/jobs/$JOB_ID/outputs",
  "archiveOnAppError": true,
  "parameterSet": {
    "appArgs": [
      {
        "name": "inputDir",
        "arg": "/scratch/06659/wmobley/clusterodm/jobs/$JOB_ID/inputs"
      },
      {
        "name": "outputDir", 
        "arg": "/scratch/06659/wmobley/clusterodm/jobs/$JOB_ID/outputs"
      }
    ]
  },
  "jobType": "BATCH",
  "maxMinutes": 120,
  "nodeCount": 1,
  "coresPerNode": 2,
  "memoryMB": 8192,
  "subscriptions": []
}
EOF
)

SUBMIT_RESPONSE=$(curl -s -X POST \
    -H "X-Tapis-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$JOB_DEF" \
    "$BASE_URL/v3/jobs")

TAPIS_JOB_UUID=$(echo "$SUBMIT_RESPONSE" | jq -r '.result.uuid // empty')

if [[ -n "$TAPIS_JOB_UUID" ]]; then
    echo "✅ Job submitted successfully!"
    echo "🆔 Tapis Job UUID: $TAPIS_JOB_UUID"
    echo "$TAPIS_JOB_UUID" > last_job_uuid.txt
    
    echo ""
    echo "🔍 Monitor this job with:"
    echo "./monitor-tapis-job.sh $TAPIS_JOB_UUID"
    
    echo ""
    echo "📋 Job will process the image and create outputs in:"
    echo "   scratch/06659/wmobley/clusterodm/jobs/$JOB_ID/outputs"
    echo ""
    echo "⏳ Use the monitor script to track progress and confirm output stays on LS6"
    
else
    echo "❌ Job submission failed:"
    echo "$SUBMIT_RESPONSE" | jq .
fi