#!/bin/bash

# Monitor Tapis job on LS6 - track from submission to completion
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJkZmRmZGY1Zi00NTk2LTQ0NGItYjkzYy1iNmZjZjI4YjM4ZjQiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY4MjkyMDAsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.o63ilr5dxa3p1_D0lBERPxY0RITBywuByp1qORPjf3ET0Vc6ebLBVtS_XxPFyQecEPw4r_aIwrR0bxMnVhVQM6hs1qgedw0GSsXWsJj-x2CHHC2ZGMFSbPC20HocYaoKBmL7sIi15cNLApJH6_9MEkarx0cia-ZXGfhs7itpX6RCaMK3zW0WYSj8T8qxLsscakH5fmJmAoIAqjhzi-rReRBLp3lwyqXhZZUErzMG1SXbWyWN_Y1h02SCpLPqyg06y6RPEpmA4rlgINCiAxEuMLGFBi8xoNs_fzhT4OelSjYQgAB1ic_vsq6K48aQS9waZSqOoM2mgOMMK_ht8HuwgA"
BASE_URL="https://portals.tapis.io"

if [[ -z "$1" ]]; then
    echo "Usage: $0 <TAPIS_JOB_UUID> [NODEODM_TOKEN]"
    echo ""
    echo "You can get the job UUID from:"
    echo "- ClusterODM logs: Look for 'Successfully submitted Tapis job <UUID>'"
    echo "- saved file: cat last_job_uuid.txt (if using test scripts)"
    exit 1
fi

JOB_UUID="$1"
NODEODM_TOKEN="$2"

if [[ -n "$NODEODM_TOKEN" ]]; then
    export ODM_NODE_TOKEN="$NODEODM_TOKEN"
    echo "🔑 Using provided NodeODM token and exporting ODM_NODE_TOKEN for downstream tooling."
fi

echo "🔍 Monitoring Tapis Job: $JOB_UUID"
echo "=================================="

while true; do
    echo "$(date): Checking job status..."
    
    # Get job status
    RESPONSE=$(curl -s -H "X-Tapis-Token: $TOKEN" "$BASE_URL/v3/jobs/$JOB_UUID")
    
    if echo "$RESPONSE" | jq -e '.result' > /dev/null 2>&1; then
        STATUS=$(echo "$RESPONSE" | jq -r '.result.status')
        REMOTE_JOB_ID=$(echo "$RESPONSE" | jq -r '.result.remoteJobId // "none"')
        LAST_MESSAGE=$(echo "$RESPONSE" | jq -r '.result.lastMessage // "no message"')
        
        echo "📊 Status: $STATUS"
        echo "🖥️  Remote Job ID (LS6): $REMOTE_JOB_ID"
        echo "💬 Last Message: $LAST_MESSAGE"
        
        case "$STATUS" in
            "PENDING"|"PROCESSING_INPUTS"|"STAGING_INPUTS"|"STAGING_JOB"|"SUBMITTING_JOB")
                echo "⏳ Job is being prepared..."
                ;;
            "QUEUED")
                echo "🕐 Job is in LS6 queue, waiting to run..."
                if [[ "$REMOTE_JOB_ID" != "none" ]]; then
                    echo "💡 You can check LS6 queue status with: squeue -u wmobley"
                fi
                ;;
            "RUNNING")
                echo "🚀 Job is running on LS6!"
                if [[ "$REMOTE_JOB_ID" != "none" ]]; then
                    echo "💡 LS6 job ID: $REMOTE_JOB_ID"
                    echo "💡 Check LS6 status: squeue -j $REMOTE_JOB_ID"
                fi
                ;;
            "ARCHIVING")
                echo "📦 Job completed, archiving results..."
                ;;
            "FINISHED")
                echo "✅ Job completed successfully!"
                
                # Check for output files
                echo ""
                echo "🗂️  Checking output files..."
                ARCHIVE_DIR=$(echo "$RESPONSE" | jq -r '.result.archiveSystemDir // "unknown"')
                echo "📁 Archive directory: $ARCHIVE_DIR"
                
                # Try to list output files
                curl -s -H "X-Tapis-Token: $TOKEN" \
                    "$BASE_URL/v3/files/listings/ls6${ARCHIVE_DIR}" | \
                    jq -r '.result[]?.name // "No files found"' | \
                    head -10
                
                echo ""
                echo "🎉 SUCCESS: Job completed and files archived on LS6!"
                echo "📂 Output location: ls6:$ARCHIVE_DIR"
                break
                ;;
            "FAILED"|"CANCELLED")
                echo "❌ Job failed or was cancelled"
                echo "Full response:"
                echo "$RESPONSE" | jq .
                break
                ;;
            *)
                echo "❓ Unknown status: $STATUS"
                ;;
        esac
    else
        echo "❌ Error getting job status:"
        echo "$RESPONSE"
        break
    fi
    
    echo "---"
    sleep 30  # Check every 30 seconds
done
