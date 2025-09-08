#!/bin/bash

# ClusterODM Tapis Job Submission Script

# Your Tapis JWT token
TOKEN="eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiI4ZjZkNTgyNS03NjY3LTQ0NGYtYTAxMi0yNTgxZDczZDJkNTEiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTY0MTgwNDMsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.vTPCCsLe7LgFv-HKmI2vXaYWNpIPMh7nOUz8NIInpcMVEjq5qCT06wVP97eW60KBvXH3-kcAoUNDwIeMfuOt5YMcY-j7TpPsgZI5__RMGC56ZhmEFSLpvvozzX7qHFOjg0rU_2thL8Q3hd8f4Xxjx2SV3SKNJS5Z_xcNQu6XN633GOwkdPftN2zjVcEzkyoErYIf_y95K3c3yKkgpgOutSNbAJGOKlXlWhmLuV_OwFblwGhORmF-KI8yc5P3uriKXRO9kNyquu6KF4ZJevI31bZiMcQD6mOeVmk9UyYBpRw9X6bCUUfENusAaPF4LxPqmeBTPVa79sFsBegJVwEP8A"

# ClusterODM endpoint
CLUSTER_ODM_URL="http://localhost:3000"

# Job name
JOB_NAME="DJI Drone Survey - $(date +%Y%m%d_%H%M%S)"

echo "Submitting job: $JOB_NAME"
echo "Images: DJI_*.JPG"
echo ""

echo "Step 1: Uploading files..."
# Submit the job and capture UUID
RESPONSE=$(curl -s -X POST "$CLUSTER_ODM_URL/task/new/init" \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=$JOB_NAME" \
  -F "images=@testData/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/DJI_20250801034351_0003_D.JPG" \
  -F "images=@testData/DJI_20250801034352_0004_D.JPG" \
  -F "images=@testData/DJI_20250801034353_0005_D.JPG")

echo "Upload response: $RESPONSE"

# Extract UUID from response (try different possible locations)
UUID=$(echo $RESPONSE | jq -r '.uuid // .data.uuid // empty' 2>/dev/null)

# If jq is not available, fallback to grep
if [ -z "$UUID" ]; then
    UUID=$(echo $RESPONSE | grep -o '"uuid":"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$UUID" ]; then
    echo "ERROR: Failed to get UUID from upload response"
    exit 1
fi

echo "Got UUID: $UUID"
echo ""

echo "Step 2: Validating files..."
# Validate files
VALIDATE_RESPONSE=$(curl -s -X POST "$CLUSTER_ODM_URL/task/new/upload/$UUID" \
  -H "Authorization: Bearer $TOKEN")

echo "Validation response: $VALIDATE_RESPONSE"

echo "Step 3: Starting task processing..."
# Commit/process the task
PROCESS_RESPONSE=$(curl -s -X POST "$CLUSTER_ODM_URL/task/new/commit/$UUID" \
  -H "Authorization: Bearer $TOKEN")

echo "Processing response: $PROCESS_RESPONSE"
echo ""

echo "Job submitted! UUID: $UUID"
echo "Check status at:"
echo "Web UI: http://localhost:3000"
echo "Admin: http://localhost:10000"
echo "Task info: curl http://localhost:3000/task/$UUID/info"