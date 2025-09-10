# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

ClusterODM-Tapis is a specialized version of ClusterODM that integrates with the Tapis API to submit photogrammetry jobs to TACC supercomputing resources. It functions as a reverse proxy, load balancer and task tracker that can distribute NodeODM-compatible processing tasks to high-performance computing (HPC) systems instead of traditional cloud VMs.

## Architecture

ClusterODM-Tapis follows a modular Node.js architecture:

**Core Components:**
- **index.js**: Main entry point and application orchestrator
- **config.js**: Configuration management with CLI argument parsing
- **admincli.js**: Telnet-based administrative CLI interface
- **adminweb.js**: Web-based administrative interface

**Key Libraries (libs/):**
- **proxy.js**: HTTP proxy server for forwarding requests
- **nodes.js**: Node management and health monitoring
- **asrProvider.js**: Auto-scaling resource provider interface
- **routetable.js**: Request routing and load balancing
- **tasktable.js**: Task tracking and state management
- **floodMonitor.js**: Request rate limiting and flood protection

**Tapis Integration:**
- **libs/asr-providers/tapis.js**: Tapis ASR provider implementation
- **libs/classes/TapisNode.js**: Tapis-specific node representation
- **docs/tapis.md**: Tapis configuration documentation

## Common Commands

### Basic Operations
```bash
# Install dependencies
npm install

# Start ClusterODM with default configuration
node index.js

# Start with specific port
node index.js --port 4000

# Start with Tapis integration
node index.js --asr tapis-config.json

# View all available options
node index.js --help
```

### Docker Operations
```bash
# Run with docker
docker run --rm -ti -p 3000:3000 -p 8080:8080 -p 10000:10000 opendronemap/clusterodm

# Use docker-compose (includes NodeODM)
docker-compose up
```

### Development Setup
```bash
# Install dependencies
npm install

# Run in debug mode
node index.js --debug

# Create Windows bundle
npm run winbundle
```

### Tapis-Specific Commands
```bash
# Set up and run Tapis integration
./run-clusterodm-tapis.sh

# Test Tapis setup
./verify-tapis-setup.js

# Monitor Tapis job status
./monitor-tapis-job.sh <job-id>

# Check running Tapis jobs
./check-tapis-jobs.sh

# Debug Tapis configuration
./debug-tapis.sh
```

### Administrative Interface
```bash
# Connect to CLI admin interface (default port 8080)
telnet localhost 8080

# Common CLI commands:
# NODE ADD <hostname> <port>    - Add a processing node
# NODE LIST                     - List all nodes
# NODE REMOVE <index>           - Remove a node
# NODE LOCK <index>             - Lock a node (prevent task assignment)
# NODE UNLOCK <index>           - Unlock a node
# ASR LIST                      - List autoscaler instances
# HELP                          - Show available commands
```

## Configuration

### Default Configuration
ClusterODM uses `config-default.json` for default settings and supports command-line overrides:

**Key Configuration Options:**
- `port`: Main proxy port (default: 3000)
- `admin-cli-port`: Admin CLI port (default: 8080)  
- `admin-web-port`: Admin web interface port (default: 10000)
- `cloud-provider`: Cloud provider for autoscaling (default: "local")
- `asr`: Path to autoscaler configuration file

### Tapis Configuration
For Tapis integration, create a `tapis-config.json` file:

```json
{
  "provider": "tapis",
  "tapis": {
    "baseUrl": "https://portals.tapis.io",
    "tenantId": "portals",
    "token": "YOUR_JWT_TOKEN"
  },
  "app": {
    "appId": "nodeodm-ls6",
    "appVersion": "1.0.5"
  },
  "system": {
    "executionSystemId": "ls6",
    "archiveSystemId": "ls6"
  },
  "job": {
    "maxJobTime": "02:00:00",
    "nodeCount": 1,
    "coresPerNode": 2,
    "memoryMB": 8192
  },
  "imageSizeMapping": [
    {
      "maxImages": 50,
      "nodeCount": 1,
      "coresPerNode": 2,
      "memoryMB": 8192,
      "maxJobTime": "02:00:00"
    }
  ]
}
```

## Key Architecture Patterns

### ASR (Auto-Scaling Resource) Pattern
ClusterODM uses an ASR provider pattern for different compute backends:
- **AbstractASRProvider**: Base class for all providers
- **TapisAsrProvider**: Submits jobs to TACC via Tapis API
- **DigitalOcean/AWS/Hetzner**: Traditional cloud VM providers

### Node Management
- **Virtual Nodes**: TapisNode instances represent HPC job submissions
- **Health Monitoring**: Regular heartbeat checks for node availability  
- **Load Balancing**: Automatic distribution based on queue size and capacity
- **State Tracking**: Persistent storage of node and task states

### Request Flow
1. **Client Request**: HTTP request to proxy port (3000)
2. **Route Selection**: routetable determines target node
3. **Proxy Forward**: Request forwarded to selected node
4. **Response Handling**: Response proxied back to client
5. **State Update**: Task and node states updated

## Tapis Integration Specifics

### Job Lifecycle
1. **Task Submission**: Client submits task with images
2. **File Upload**: Images uploaded to Tapis storage system
3. **Job Creation**: Tapis job submitted to execution system
4. **Job Monitoring**: Periodic status checks via Tapis API
5. **Result Retrieval**: Processed results archived on Tapis storage
6. **Cleanup**: Temporary files and job artifacts cleaned up

### Resource Mapping
The `imageSizeMapping` configuration automatically selects compute resources based on the number of input images, allowing efficient resource allocation for different dataset sizes.

### Authentication
Requires valid Tapis JWT tokens for API access. Tokens have limited lifetimes and must be refreshed periodically.

## File Structure

```
├── index.js              # Main entry point
├── config.js             # Configuration management  
├── admincli.js           # CLI admin interface
├── adminweb.js           # Web admin interface
├── libs/
│   ├── asr-providers/    # Auto-scaling providers
│   │   └── tapis.js      # Tapis integration
│   ├── classes/          # Core classes
│   ├── cloud-providers/  # Cloud provider implementations
│   ├── proxy.js          # HTTP proxy logic
│   ├── nodes.js          # Node management
│   └── routetable.js     # Request routing
├── docs/
│   └── tapis.md          # Tapis setup guide
├── tapis-config*.json    # Tapis configuration files
└── run-clusterodm-tapis.sh # Tapis setup script
```

## Monitoring and Debugging

### Interfaces
- **Web Interface**: http://localhost:3000 (NodeODM-compatible UI)
- **Admin Web**: http://localhost:10000 (node status and management)
- **Admin CLI**: telnet localhost 8080 (command-line administration)

### Log Files
- **clusterodm-tapis.log**: Main application log
- **ClusterODM.log**: General ClusterODM operations
- Console output includes startup, job submission, and error information

### Debugging Tools
- `--debug` flag enables verbose logging and disables caches
- Tapis-specific debug scripts for testing API connectivity
- Built-in flood monitoring and rate limiting

## Development Notes

### Dependencies
- Requires Node.js 14 or earlier (compatibility issues with Node.js 16+)
- Key dependencies: express, axios, winston (logging), minimist (CLI parsing)
- Uses `node-libcurl` for high-performance HTTP operations

### Testing
- No formal test suite (test script returns error)
- Manual testing via included shell scripts for Tapis functionality
- `test-upload.html` for basic upload testing

### Windows Support
- Includes `winbundle.js` for creating Windows executables
- Self-contained bundle with minimal dependencies