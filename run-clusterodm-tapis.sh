#!/bin/bash

# Complete ClusterODM + Tapis Integration Script
# This script sets up and runs ClusterODM with Tapis integration for LS6

echo "🚀 ClusterODM + Tapis LS6 Integration Setup"
echo "==========================================="

# Configuration - UPDATE THIS TOKEN WHEN IT EXPIRES
WORKING_TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiI1NWU1NzMzZS1mZDc1LTRmZTUtODQ4Yi00N2Q2ZmE3MDA3ZjEiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTcwMTgxMjIsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.pyOqw28_yRml4T60BVTK6DAJ_17cperBfE1oH3JitA5JNlVjTvUJjFvkgFV4tAS0UEcGZFhSuFGB-vN5xU7UsD2Va8vAol53ywPuvwv4JfT-v0zO1rTGq0G_ruJtDWyTeCOOGJOSLPZTeusfRfsUaZnImBlZif1uMpwpuhbE9wtG64D0zA3ZZjcsbqmPWb4Dmcj7B-mHwFVoz8uUiKJlFSKFJYpIrBpnAQRr49jw-ItJ8kfg4lcOZn9X11l7dJR1ZwVgCuyu628YdUUr1BlngFF_5tjuuUovpeGZTWPuHsq6y-0LQWYPmzMVmhcL-LWdNnuXV2to-ju-8O8Voy8Urw"

# Step 1: Kill any existing processes and clean up
echo "🔧 Step 1: Cleaning up existing processes, logs, and old node data..."
pkill -f "node index.js" || true
pkill -f "monitor-tapis-job.sh" || true
pkill -f "test-" || true

# Clean up logs for fresh start
rm -f ClusterODM.log 2>/dev/null || true
rm -f clusterodm-tapis.log 2>/dev/null || true
rm -f *.log 2>/dev/null || true

# Clean up old node persistence data to prevent failed node accumulation
rm -f routetable.db* 2>/dev/null || true
rm -f tasktable.db* 2>/dev/null || true
rm -f nodes.db* 2>/dev/null || true
rm -rf tmp/* 2>/dev/null || true

echo "✅ Cleanup complete (removed logs, old node data, and temp files)"
echo ""

# Step 2: Test token validity
echo "🔑 Step 2: Testing Tapis token..."
TOKEN_TEST=$(curl -s -H "X-Tapis-Token: $WORKING_TOKEN" "https://portals.tapis.io/v3/systems/ls6" | jq -r '.status // "failed"')

if [[ "$TOKEN_TEST" == "success" ]]; then
    echo "✅ Token is valid and working"
else
    echo "❌ Token validation failed. Please update WORKING_TOKEN in this script."
    echo "   Get a fresh token from: https://portals.tapis.io"
    exit 1
fi
echo ""

# Step 3: Update tapis-config.json with working token
echo "📝 Step 3: Updating tapis-config.json..."
cat > tapis-config.json << EOF
{
  "provider": "tapis",
  "tapis": {
    "baseUrl": "https://portals.tapis.io",
    "tenantId": "portals",
    "token": "$WORKING_TOKEN"
  },
  "app": {
    "appId": "nodeodm-ls6",
    "appVersion": "1.0.5-sha-a30b980"
  },
  "system": {
    "executionSystemId": "ls6",
    "archiveSystemId": "ls6"
  },
  "job": {
    "maxJobTime": "02:00:00",
    "nodeCount": 1,
    "coresPerNode": 2,
    "memoryMB": 8192,
    "archiveOnAppError": true
  },
  "maxRuntime": 7200,
  "maxUploadTime": 3600,
  "jobLimit": 10,
  "createRetries": 3,
  "imageSizeMapping": [
    {
      "maxImages": 50,
      "nodeCount": 1,
      "coresPerNode": 2,
      "memoryMB": 8192,
      "maxJobTime": "02:00:00"
    },
    {
      "maxImages": 200,
      "nodeCount": 1,
      "coresPerNode": 4,
      "memoryMB": 16384,
      "maxJobTime": "04:00:00"
    },
    {
      "maxImages": 500,
      "nodeCount": 1,
      "coresPerNode": 8,
      "memoryMB": 32768,
      "maxJobTime": "08:00:00"
    },
    {
      "maxImages": 1000,
      "nodeCount": 2,
      "coresPerNode": 8,
      "memoryMB": 32768,
      "maxJobTime": "12:00:00"
    }
  ]
}
EOF
echo "✅ Configuration updated with working token"
echo ""

# Step 4: Create test image directory
echo "📁 Step 4: Preparing test images..."
mkdir -p testData/small 2>/dev/null || true
if [[ ! -f "testData/small/DJI_20250801034350_0002_D.JPG" ]]; then
    if [[ -f "testData/DJI_20250801034350_0002_D.JPG" ]]; then
        cp testData/DJI_20250801034350_0002_D.JPG testData/small/
        echo "✅ Copied test image to small directory"
    else
        echo "⚠️  No test images found - you can still test with your own images"
    fi
else
    echo "✅ Test images ready"
fi
echo ""

# Step 5: Start ClusterODM
echo "🚀 Step 5: Starting ClusterODM with Tapis integration..."
node index.js --asr tapis-config.json --port 3000 > clusterodm-tapis.log 2>&1 &
CLUSTERODM_PID=$!

# Wait for startup
echo "⏳ Waiting for ClusterODM to start..."
sleep 5

# Test if ClusterODM is running
CLUSTERODM_STATUS=$(curl -s http://localhost:3000/info 2>/dev/null | jq -r '.version // "failed"')

if [[ "$CLUSTERODM_STATUS" != "failed" ]]; then
    echo "✅ ClusterODM started successfully (PID: $CLUSTERODM_PID)"
    echo "   Version: $CLUSTERODM_STATUS"
    echo "   Web interface: http://localhost:3000"
    echo "   Admin interface: http://localhost:10000"
    
    # Step 5.1: Clean up any old failed nodes via admin web API
    echo ""
    echo "🧹 Cleaning up old failed nodes..."
    sleep 3  # Give ClusterODM more time to fully initialize
    
    # Get list of nodes and delete them one by one
    NODES_JSON=$(curl -s "http://localhost:10000/r/node/list" 2>/dev/null || echo "[]")
    NODE_COUNT=$(echo "$NODES_JSON" | jq -r 'length // 0' 2>/dev/null || echo "0")
    
    if [[ "$NODE_COUNT" -gt 0 ]]; then
        echo "   Found $NODE_COUNT existing nodes, removing them..."
        
        # Delete nodes by index (starting from 1, going backwards to avoid index shifting)
        for ((i=$NODE_COUNT; i>=1; i--)); do
            DELETE_RESULT=$(curl -s -X DELETE "http://localhost:10000/r/node" \
                -H "Content-Type: application/json" \
                -d "{\"number\": $i}" 2>/dev/null || echo "failed")
            echo "   Removed node $i"
            sleep 0.2
        done
        
        # Verify cleanup
        REMAINING_NODES=$(curl -s "http://localhost:10000/r/node/list" 2>/dev/null | jq -r 'length // 0' 2>/dev/null || echo "0")
        echo "✅ Node cleanup complete (removed $NODE_COUNT nodes, $REMAINING_NODES remaining)"
    else
        echo "✅ No old nodes found to clean up"
    fi
    
else
    echo "❌ ClusterODM failed to start"
    echo "   Check logs: tail -f clusterodm-tapis.log"
    exit 1
fi
echo ""

# Step 6: Summary and next steps
echo "🎉 SETUP COMPLETE!"
echo "=================="
echo ""
echo "✅ ClusterODM is running with Tapis integration"
echo "✅ Files will be uploaded to LS6 scratch: scratch/06659/wmobley/clusterodm/jobs/{job-id}"
echo "✅ Jobs will run on TACC LS6 supercomputer"
echo "✅ Output files WILL STAY ON LS6"
echo ""
echo "📋 What's running:"
echo "   - ClusterODM: http://localhost:3000 (PID: $CLUSTERODM_PID)"
echo "   - Logs: tail -f clusterodm-tapis.log"
echo ""
echo "🔧 To submit jobs:"
echo "   curl -X POST http://localhost:3000/task/new \\"
echo "     -F 'images=@your-image.jpg' \\"
echo "     -F 'options=[]' \\"
echo "     -F 'webhook=http://example.com/webhook'"
echo ""
echo "🛑 To stop:"
echo "   kill $CLUSTERODM_PID"
echo ""
echo "💡 If token expires, update WORKING_TOKEN in this script and run again."