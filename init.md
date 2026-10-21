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
- **Admin CLI**: telnet localhost:8080 when started with `--admin-pass`; loopback-only
- **Admin web interface**: http://localhost:10000

### Custom Ports (if needed)

```bash
node index.js --asr tapis-config.json --port 3001 --admin-cli-port 8081 --admin-web-port 10001
```

The admin CLI is disabled when `--admin-pass` is omitted. If enabled, it binds to loopback and
should be reached remotely through an SSH tunnel. If its port is already in use, ClusterODM
reports the bind error while continuing the web and proxy services; choose a free port or set
`--admin-cli-port 0` to disable it explicitly.

## JWT Token Authentication

ClusterODM-Tapis uses JWT tokens per request, not in the config file. A startup token is optional
and only enables a preflight check.

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
  -H "Authorization: Bearer ${TAPIS_TOKEN:?Set TAPIS_TOKEN}" \
  -F "images=@testData/small/DJI_20250801034350_0002_D.JPG" \
  -F "images=@testData/small/DJI_20250801034351_0003_D.JPG" \
  -F "name=Small Tapis Test Job" \
  -F "options=[]"
```

### Using Full Test Set (3 images from testData/)

```bash
# Submit a larger processing job with your JWT token
curl -X POST "http://localhost:3000/task/new" \
  -H "Authorization: Bearer ${TAPIS_TOKEN:?Set TAPIS_TOKEN}" \
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
- **Admin CLI**: `telnet localhost 8080` after starting with `--admin-pass`; use an SSH tunnel for remote access
