# ClusterODM-Tapis Initialization Guide

## Starting ClusterODM-Tapis

ClusterODM-Tapis now supports per-request JWT authentication instead of requiring tokens in the configuration file.

### Basic Startup

```bash
cd /Users/wmobley/Documents/GitHub/odm-suite/ClusterODM-Tapis
node index.js --asr tapis-config.json
```

This will start ClusterODM-Tapis on:
- **Main proxy**: http://localhost:3000
- **Admin CLI**: telnet localhost:8080
- **Admin web interface**: http://localhost:10000

### Custom Ports (if needed)

```bash
node index.js --asr tapis-config.json --port 3001 --admin-cli-port 8081 --admin-web-port 10001
```

## JWT Token Authentication

ClusterODM-Tapis now requires JWT tokens to be provided with each request, not in the config file.

### Option 1: Authorization Header (Recommended)

```bash
curl -X POST "http://localhost:3000/task/new" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -F "images=@testData/DJI_20250801034349_0001_D.JPG" \
  -F "images=@testData/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/DJI_20250801034351_0003_D.JPG" \
  -F "name=Test Task" \
  -F "options=[]"
```

### Option 2: Query Parameter

```bash
curl -X POST "http://localhost:3000/task/new?token=YOUR_JWT_TOKEN_HERE" \
  -F "images=@testData/DJI_20250801034349_0001_D.JPG" \
  -F "images=@testData/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/DJI_20250801034351_0003_D.JPG" \
  -F "name=Test Task" \
  -F "options=[]"
```

## Example with Test Data

### Using Small Test Set (2 images from testData/small/)

```bash
# Make sure you're in the ClusterODM-Tapis directory
cd /Users/wmobley/Documents/GitHub/odm-suite/ClusterODM-Tapis

# Submit a small processing job with your JWT token (faster for testing)
curl -X POST "http://localhost:3000/task/new" \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJlMTZmNDI2NC1hZjA5LTQ2NDUtODU2Zi1jNjQzZTgyYzhkMGYiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTc1MzQzMzEsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.h802fj6vU-ZBXDAUmfkabrkX3gPxo3pm3QkB_FdG51_A2KZxCPXuMrDiadO-8j4bmj3lZB2eXjPvclXtyHG02fm2Bi5-lpH4cS0KO-Soq5d1rdRpfYSJTJNmnxbR60ehujhgMtufEtSmCU6ch-apqczrwg4QlWbZ2TIoAZk6Nh0fI95hMQp3N4lokBQAJ0diSY5CFLXMCuXGOz58qsV6Co-8ENNrB1TfpnnAvGQxa9nZTh6LD5AMCx86DM_gD4fwiEGzI0yJ5Oh94XfrAVI3fgRblHVOQBPwkAHhidN3njNBF8_OZvLJYrCn3CcJ6BeIncsmeCPZlwan5a2ena59mw" \
  -F "images=@testData/small/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/small/DJI_20250801034351_0003_D.JPG" \
  -F "name=Small Tapis Test Job" \
  -F "options=[]"
```

### Using Full Test Set (3 images from testData/)

```bash
# Submit a larger processing job with your JWT token
curl -X POST "http://localhost:3000/task/new" \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Imd5YU5uVXJJZGxsYkhkWU5vWEpoRE85NTZDa0pkbWdybURPSDJNZHNnclkiLCJ0eXAiOiJKV1QifQ.eyJqdGkiOiJlMTZmNDI2NC1hZjA5LTQ2NDUtODU2Zi1jNjQzZTgyYzhkMGYiLCJpc3MiOiJodHRwczovL3BvcnRhbHMudGFwaXMuaW8vdjMvdG9rZW5zIiwic3ViIjoid21vYmxleUBwb3J0YWxzIiwidGFwaXMvdGVuYW50X2lkIjoicG9ydGFscyIsInRhcGlzL3Rva2VuX3R5cGUiOiJhY2Nlc3MiLCJ0YXBpcy9kZWxlZ2F0aW9uIjpmYWxzZSwidGFwaXMvZGVsZWdhdGlvbl9zdWIiOm51bGwsInRhcGlzL3VzZXJuYW1lIjoid21vYmxleSIsInRhcGlzL2FjY291bnRfdHlwZSI6InVzZXIiLCJleHAiOjE3NTc1MzQzMzEsInRhcGlzL2NsaWVudF9pZCI6bnVsbCwidGFwaXMvZ3JhbnRfdHlwZSI6InBhc3N3b3JkIn0.h802fj6vU-ZBXDAUmfkabrkX3gPxo3pm3QkB_FdG51_A2KZxCPXuMrDiadO-8j4bmj3lZB2eXjPvclXtyHG02fm2Bi5-lpH4cS0KO-Soq5d1rdRpfYSJTJNmnxbR60ehujhgMtufEtSmCU6ch-apqczrwg4QlWbZ2TIoAZk6Nh0fI95hMQp3N4lokBQAJ0diSY5CFLXMCuXGOz58qsV6Co-8ENNrB1TfpnnAvGQxa9nZTh6LD5AMCx86DM_gD4fwiEGzI0yJ5Oh94XfrAVI3fgRblHVOQBPwkAHhidN3njNBF8_OZvLJYrCn3CcJ6BeIncsmeCPZlwan5a2ena59mw" \
  -F "images=@testData/DJI_20250801034349_0001_D.JPG" \
  -F "images=@testData/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/DJI_20250801034351_0003_D.JPG" \
  -F "name=Tapis Test Job" \
  -F "options=[]"
```

## Response

A successful request will return a task UUID:

```json
{"uuid":"f9d7aae7-b0ab-4c54-919f-cd65b4da4767"}
```

## Key Changes

- **No token in config**: The `tapis-config.json` file no longer needs a `token` field
- **Per-request authentication**: JWT tokens must be provided with each request
- **Two token methods**: Authorization header (preferred) or query parameter
- **Token validation**: Each token is validated against the Tapis API before job submission

## Error Handling

If no token is provided, you'll get:
```
Tapis JWT token must be provided in request headers (Authorization: Bearer <token>) or query parameters (?token=<token>)
```

If the token is invalid, you'll get a validation error from the Tapis API.

## Monitoring

- **Admin web interface**: http://localhost:10000 - View node status and job management
- **Logs**: Check console output for detailed processing information
- **Admin CLI**: `telnet localhost 8080` - Command-line administration