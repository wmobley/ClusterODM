# Automatic Node Registration via Webhook

This document describes the automatic node registration system for ClusterODM-Tapis, which eliminates the need for manual telnet-based node registration.

## Overview

The webhook registration system allows compute nodes to automatically register themselves with the ClusterODM cluster when they start up. This is particularly useful for HPC environments where:

- Telnet access may not be available (like LS6)
- Nodes start at unpredictable times (e.g., midnight job schedules)
- Manual registration is impractical for large numbers of nodes

The system supports multiple authentication methods:
- **Tapis JWT tokens** (recommended for Tapis deployments) - leverages existing Tapis authentication
- **Registration secrets** (traditional approach) - shared secret authentication
- **No authentication** (testing/trusted networks only)

The system includes both **registration** and **de-registration** capabilities:
- **Registration** - nodes join the cluster when they start up
- **De-registration** - nodes leave the cluster when jobs complete or fail
- **Automatic cleanup** - removes inactive nodes and cleans up resources

## Architecture

### Cluster Side (ClusterODM)

**Webhook Endpoints**:
- `POST /webhook/register-node` - Register a new node
- `POST /webhook/deregister-node` - Remove an existing node

The cluster exposes REST endpoints that accept node management requests. These endpoints:
- Validates node information (hostname, port)
- Supports multiple authentication methods:
  - **Tapis JWT validation** - verifies tokens against Tapis API
  - **Registration secret** - traditional shared secret
  - **No authentication** - for testing environments
- Adds the node to the cluster using the existing `nodes.addUnique()` logic
- Returns success/failure status with authentication method used

### Node Side (Compute Nodes)

**Registration & De-registration Clients**:
- `register-node.js` / `register-node.sh` - Node registration and de-registration
- `deregister-node.js` / `deregister-node.sh` - Standalone de-registration clients

Multiple client implementations are provided:
- **Node.js clients**: Full-featured with detailed error handling
- **Shell scripts**: Lightweight using curl, perfect for HPC environments
- **Unified interface**: Both registration and de-registration in same clients
- **Standalone tools**: Dedicated de-registration scripts for cleanup scenarios

## Configuration

### Cluster Configuration

Start ClusterODM with optional authentication:

```bash
# Without authentication (testing only)
node index.js --admin-web-port 10000

# With Tapis ASR provider (automatically enables JWT validation)
node index.js --admin-web-port 10000 --asr tapis-config.json

# With shared secret authentication
node index.js --admin-web-port 10000 --registration-secret "your-secret-key"

# With both Tapis and fallback secret
node index.js --admin-web-port 10000 --asr tapis-config.json --registration-secret "fallback-secret"
```

Configuration options:
- `--asr <file>`: Enable Tapis ASR provider (automatically enables JWT token validation)
- `--registration-secret <string>`: Shared secret for fallback authentication (optional)
- `--admin-web-port <port>`: Port for the admin web interface (default: 10000)

**Authentication Priority**:
1. **Tapis JWT token** - validated against Tapis API if ASR provider is configured
2. **Registration secret** - fallback if JWT not provided or invalid
3. **No authentication** - only if no secret is configured

### Node Configuration

#### Using the Node.js Client

```bash
# Basic registration
node register-node.js --cluster-host clusterodm.example.com

# With Tapis JWT token (recommended for Tapis deployments)
node register-node.js \
    --cluster-host clusterodm.example.com \
    --cluster-port 10000 \
    --node-host 192.168.1.100 \
    --node-port 3000 \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."

# With traditional secret
node register-node.js \
    --cluster-host clusterodm.example.com \
    --registration-secret "your-secret-key"
```

#### Using the Shell Script

```bash
# With Tapis JWT token
./register-node.sh \
    --cluster-host clusterodm.example.com \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."

# With environment variables (Tapis)
export CLUSTER_HOST=clusterodm.example.com
export NODE_HOST=$(hostname -I | awk '{print $1}')
export TAPIS_TOKEN="eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."
./register-node.sh

# With traditional secret
export CLUSTER_HOST=clusterodm.example.com
export NODE_HOST=$(hostname -I | awk '{print $1}')
export REGISTRATION_SECRET="your-secret-key"
./register-node.sh
```

## HPC Integration Examples

### SLURM Job Script

```bash
#!/bin/bash
#SBATCH --job-name=nodeodm-worker
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --time=02:00:00

# Set cluster configuration (Tapis approach)
export CLUSTER_HOST="head-node.cluster.edu"
export TAPIS_TOKEN="${TAPIS_JWT_TOKEN}"  # Passed from Tapis job environment

# Alternative: traditional approach
# export REGISTRATION_SECRET="your-shared-secret"

# Start NodeODM
module load apptainer
apptainer run docker://opendronemap/nodeodm &

# Wait for NodeODM to start
sleep 30

# Auto-register with cluster
./register-node.sh

# Keep job running
wait
```

### Tapis Integration

For Tapis jobs, the JWT token is already available and can be used for authentication:

```bash
# In your Tapis job script
export CLUSTER_HOST="${TAPIS_CLUSTER_HOST}"
export NODE_HOST=$(hostname -I | awk '{print $1}')
export TAPIS_TOKEN="${TAPIS_JWT_TOKEN}"  # Use the same token from job submission

# Start NodeODM
apptainer run docker://opendronemap/nodeodm &
sleep 30

# Register with cluster using Tapis JWT token
./register-node.sh

# Alternative: Use the Node.js client directly
# node register-node.js \
#   --cluster-host "${CLUSTER_HOST}" \
#   --tapis-token "${TAPIS_TOKEN}"
```

**Benefits of using Tapis JWT tokens**:
- **No additional secrets** - reuses existing Tapis authentication
- **Secure** - tokens are cryptographically signed and time-limited
- **Automatic validation** - ClusterODM validates tokens against Tapis API
- **Audit trail** - token usage can be tracked through Tapis logs

## Node De-registration

### Why De-registration Matters

Automatic de-registration is crucial for:
- **Resource cleanup** - removes completed jobs from cluster view
- **Accurate capacity tracking** - prevents stale nodes from affecting load balancing
- **Auto-spawned node cleanup** - properly destroys Tapis jobs and cloud resources
- **Clean job termination** - ensures graceful shutdown on job completion or failure

### De-registration Methods

#### Using the Node.js Client

```bash
# De-register with Tapis JWT token
node register-node.js \
    --cluster-host clusterodm.example.com \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..." \
    --deregister

# De-register with node ID (most reliable)
node register-node.js \
    --cluster-host clusterodm.example.com \
    --node-id 3 \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..." \
    --deregister

# Using standalone de-registration client
node deregister-node.js \
    --cluster-host clusterodm.example.com \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."
```

#### Using Shell Scripts

```bash
# De-register with unified script
./register-node.sh \
    --cluster-host clusterodm.example.com \
    --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..." \
    --deregister

# Using standalone de-registration script
./deregister-node.sh \
    --cluster-host clusterodm.example.com \
    --tapis-token "eyJ0eXAiOiJKV1QiOaibGciOiJSUzI1NiJ9..."

# Using environment variables for cleanup
export CLUSTER_HOST=clusterodm.example.com
export TAPIS_TOKEN="eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."
./deregister-node.sh
```

### HPC Job Cleanup Integration

#### SLURM Exit Handlers

```bash
#!/bin/bash
#SBATCH --job-name=nodeodm-worker

# Configure cleanup
export CLUSTER_HOST="head-node.cluster.edu"
export TAPIS_TOKEN="${TAPIS_JWT_TOKEN}"

# Set up automatic cleanup on job exit
cleanup() {
    echo "Job ending, de-registering from cluster..."
    ./deregister-node.sh
}
trap cleanup EXIT SIGTERM SIGINT

# Start NodeODM and register
apptainer run docker://opendronemap/nodeodm &
sleep 30
./register-node.sh

# Keep job running
wait
```

#### Signal Handling

```bash
# Handle various termination scenarios
trap 'deregister_and_exit SIGTERM' SIGTERM
trap 'deregister_and_exit SIGINT' SIGINT
trap 'deregister_and_exit EXIT' EXIT

deregister_and_exit() {
    local signal=$1
    echo "Received $signal, cleaning up..."

    # De-register from cluster
    ./deregister-node.sh --cluster-host "$CLUSTER_HOST" --tapis-token "$TAPIS_TOKEN"

    # Stop services
    pkill -f nodeodm

    echo "Cleanup completed for $signal"
    exit 0
}
```

## API Reference

### Registration Endpoint

**URL**: `POST /webhook/register-node`

**Request Body**:
```json
{
    "hostname": "192.168.1.100",
    "port": 3000,
    "token": "optional-nodeodm-token",
    "tapisToken": "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9...",
    "registrationSecret": "optional-shared-secret"
}
```

**Authentication Fields** (provide one):
- `tapisToken`: Tapis JWT token (preferred for Tapis deployments)
- `registrationSecret`: Shared secret (traditional approach)
- Neither: No authentication (if cluster doesn't require it)

**Response** (Success):
```json
{
    "success": true,
    "message": "Node registered successfully",
    "nodeId": 3,
    "authMethod": "tapis-jwt"
}
```

**Response** (Error):
```json
{
    "success": false,
    "error": "Tapis token validation failed: token is expired"
}
```

**HTTP Status Codes**:
- `200`: Success or node already exists
- `400`: Missing required fields (hostname, port) or Tapis provider not configured
- `401`: Invalid authentication (Tapis token or registration secret)

### De-registration Endpoint

**URL**: `POST /webhook/deregister-node`

**Request Body**:
```json
{
    "hostname": "192.168.1.100",
    "port": 3000,
    "nodeId": 3,
    "tapisToken": "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9...",
    "registrationSecret": "optional-shared-secret"
}
```

**Identification Fields** (provide one or both):
- `nodeId`: Node ID from registration response (most reliable)
- `hostname` + `port`: Find node by network address

**Authentication Fields** (provide one):
- `tapisToken`: Tapis JWT token (preferred for Tapis deployments)
- `registrationSecret`: Shared secret (traditional approach)
- Neither: No authentication (if cluster doesn't require it)

**Response** (Success):
```json
{
    "success": true,
    "message": "Node de-registered successfully",
    "nodeInfo": "192.168.1.100:3000",
    "authMethod": "tapis-jwt"
}
```

**Response** (Error):
```json
{
    "success": false,
    "error": "Node with ID 3 not found"
}
```

**HTTP Status Codes**:
- `200`: Success (node removed)
- `400`: Missing required identification fields
- `401`: Invalid authentication (Tapis token or registration secret)
- `404`: Node not found (may already be removed)
- `500`: Internal error removing node

## Security Considerations

### Tapis JWT Token Authentication (Recommended)

For Tapis deployments, use JWT tokens for the strongest security:

**Advantages**:
- Tokens are cryptographically signed by Tapis
- Time-limited (automatic expiration)
- Validated against live Tapis API
- No additional secret management required
- Audit trail through Tapis logs

**Configuration**:
```bash
# Enable Tapis ASR provider (enables JWT validation)
node index.js --admin-web-port 10000 --asr tapis-config.json
```

### Shared Secret Authentication (Fallback)

For non-Tapis environments or fallback authentication:

1. **Generate a strong secret**:
   ```bash
   openssl rand -hex 32
   ```

2. **Configure the cluster**:
   ```bash
   node index.js --registration-secret "your-generated-secret"
   ```

3. **Distribute to nodes securely** (use environment variables, avoid hardcoding)

### Network Security

- The webhook endpoint is exposed on the admin web port (default: 10000)
- Consider firewall rules to restrict access to trusted networks
- Use HTTPS in production (configure SSL certificates)

### Alternative: No Authentication

For testing or trusted networks, you can run without a registration secret:

```bash
# Cluster side - no secret required
node index.js --admin-web-port 10000

# Node side - no secret needed
./register-node.sh --cluster-host clusterodm.example.com
```

## Troubleshooting

### Common Issues

1. **Connection Refused**:
   - Check that ClusterODM is running
   - Verify the cluster host and port
   - Check firewall/network connectivity

2. **Authentication Failed (401)**:
   - Verify the registration secret matches
   - Check for typos in the secret

3. **Node Already Exists**:
   - This is usually not an error - the node is already registered
   - Check the cluster admin interface to verify

4. **NodeODM Not Responding**:
   - Ensure NodeODM is fully started before registration
   - Add appropriate sleep delays in scripts

### Debug Commands

```bash
# Test cluster connectivity
curl -v http://clusterodm.example.com:10000/r/info

# Test NodeODM connectivity
curl -v http://localhost:3000/info

# Test registration manually
curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"hostname":"192.168.1.100","port":3000,"registrationSecret":"your-secret"}' \
     http://clusterodm.example.com:10000/webhook/register-node
```

### Log Monitoring

Monitor ClusterODM logs for registration events:

```bash
# Look for registration messages
tail -f ClusterODM.log | grep -i "registration\|webhook"
```

## Migration from Telnet

### Before (Manual Registration)

```bash
# Manual process
telnet clusterodm.example.com 8080
> NODE ADD 192.168.1.100 3000
> exit
```

### After (Automatic Registration)

```bash
# Automatic process
export CLUSTER_HOST=clusterodm.example.com
export REGISTRATION_SECRET="your-secret"
./register-node.sh
```

### Compatibility

The webhook registration system is fully compatible with existing telnet-based registration:
- Existing nodes continue to work unchanged
- Manual registration still available via telnet
- Mixed environments (manual + automatic) are supported

## Advanced Usage

### Retry Configuration

Configure retry behavior for unreliable networks:

```bash
./register-node.sh \
    --cluster-host clusterodm.example.com \
    --retries 10 \
    --retry-delay 30
```

### Health Checking

The registration scripts can optionally verify NodeODM is running before registration:

```bash
# Node.js client automatically checks NodeODM
node register-node.js --cluster-host clusterodm.example.com

# Shell script also validates
./register-node.sh --cluster-host clusterodm.example.com
```

### Environment Variable Configuration

All options can be set via environment variables for easier HPC integration:

```bash
export CLUSTER_HOST="clusterodm.example.com"
export CLUSTER_PORT="10000"
export NODE_HOST=$(hostname -I | awk '{print $1}')
export NODE_PORT="3000"
export NODE_TOKEN=""
export REGISTRATION_SECRET="your-secret"
export RETRIES="5"
export RETRY_DELAY="10"

# Now just run with no arguments
./register-node.sh
```

## Implementation Details

### Endpoint Implementation

The webhook endpoint is implemented in `adminweb.js`:

```javascript
app.post("/webhook/register-node", (req, res) => {
    const { hostname, port, token, registrationSecret } = req.body;

    // Validation and authentication logic
    if (options.registrationSecret && registrationSecret !== options.registrationSecret) {
        return res.status(401).json({ error: "Invalid registration secret" });
    }

    // Use existing node management logic
    const node = nodes.addUnique(hostname, port, token);
    // ...
});
```

### Client Implementation

Two client implementations provide flexibility:

1. **Node.js** (`register-node.js`): Uses axios for HTTP requests, detailed error handling
2. **Shell** (`register-node.sh`): Uses curl, minimal dependencies, perfect for HPC

Both implementations support:
- Automatic IP detection
- Configurable retry logic
- Environment variable configuration
- Comprehensive error reporting