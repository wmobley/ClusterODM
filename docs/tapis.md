# Tapis Integration for ClusterODM

This document describes how to configure ClusterODM to use Tapis for submitting ODM jobs to TACC supercomputing resources.

## Overview

The Tapis ASR (AutoScale Resource) provider allows ClusterODM to submit ODM processing jobs to TACC's supercomputing systems through the Tapis API instead of creating traditional cloud VMs. This integration provides access to more powerful computing resources and can be more cost-effective for large-scale photogrammetry processing.

## Prerequisites

1. **Tapis Account**: You need a valid Tapis account with access to TACC systems
2. **Tapis Application**: A Tapis application definition for NodeODM must be created
3. **System Access**: Access to both execution and storage systems on TACC
4. **Authentication**: Valid Tapis JWT tokens for API access

## Configuration

### 1. Create Configuration File

Copy the sample configuration file and modify it for your environment:

```bash
cp tapis-config-sample.json tapis-config.json
```

### 2. Configuration Parameters

#### Basic Tapis Settings
- `tapis.baseUrl`: Tapis API base URL (typically `https://tacc.tapis.io`)
- `tapis.tenantId`: Your Tapis tenant ID (typically `tacc`)

#### Application Settings
- `app.appId`: The ID of your Tapis application for NodeODM
- `app.appVersion`: Version of the NodeODM application to use

#### System Settings
- `system.executionSystemId`: Tapis system ID where jobs will run
- `system.archiveSystemId`: Tapis system ID where files will be stored
- `system.logicalQueue`: Default Tapis logical queue
- `system.queueFilter`: Optional fallback queue list when the Tapis app does not expose `notes.queueFilter`

#### Scheduler Settings
- `scheduler.defaultAllocation`: Fallback TACC allocation charge code. WebODM should normally submit a user-specific allocation from TAS.

#### Job Configuration
- `job.maxJobTime`: Maximum wall time for jobs (HH:MM:SS format)
- `job.nodeCount`: Number of compute nodes to request
- `job.coresPerNode`: Number of CPU cores per node
- `job.memoryMB`: Memory per node in MB
- `job.archiveOnAppError`: Whether to archive results even if job fails

#### Scaling Configuration
- `maxRuntime`: Maximum runtime in seconds before forced termination
- `maxUploadTime`: Maximum upload time in seconds
- `jobLimit`: Maximum number of concurrent jobs (-1 for unlimited)
- `createRetries`: Number of retry attempts for job submission

#### Image Size Mapping
The `imageSizeMapping` array defines resource allocation based on the number of input images:

```json
"imageSizeMapping": [
    {
        "maxImages": 50,
        "jobCount": 1,
        "nodeCount": 1,
        "logicalQueue": "vm-small",
        "coresPerNode": 2,
        "memoryMB": 8192,
        "maxJobTime": "02:00:00"
    }
]
```

- `logicalQueue`, `nodeCount`, and `maxJobTime` set the default WebODM Tapis queue, number of Tapis compute nodes, and max runtime for datasets up to `maxImages`.
- `jobCount` controls how many Tapis jobs are submitted in parallel for datasets up to `maxImages`. Each job uses the mapped `nodeCount` (or an optional `computeNodeCount` override) to size the Tapis allocation.
- When split-merge processing is enabled (default), ClusterODM automatically sets the ODM `--split` option so that each Tapis job handles roughly `images / jobCount` images, ensuring submodels are distributed across the available nodes.

## WebODM Task Options

ClusterODM exposes these Tapis-specific options through `/options`:

- `tapis-queue`: Queue choices come from the Tapis app `notes.queueFilter`, falling back to `system.queueFilter`.
- `tapis-allocation`: TACC allocation charge code. WebODM populates this from TAS using service credentials.
- `tapis-max-run-time`: Runtime in minutes, capped at 2880 minutes.
- `tapis-node`: Number of Tapis compute nodes to request, capped by `job.maxNodesPerJob`.

Queue, max runtime, and node-count defaults include image-count metadata from `imageSizeMapping`, so WebODM can preselect values based on the number of uploaded photos. These options are used only to build the Tapis job submission. They are stripped before the ODM task is forwarded to NodeODM. When a selected queue starts with `gpu-`, ClusterODM forces ODM `no-gpu` to `false` so GPU acceleration is not disabled on GPU queues.

## Usage

### 1. Start ClusterODM with Tapis Provider

```bash
node index.js --asr tapis-config.json
```

### 2. Authentication

When submitting tasks to ClusterODM, include a valid Tapis JWT token:

```bash
curl -X POST http://localhost:3000/task/new/init \
  -H "Authorization: Bearer YOUR_TAPIS_JWT_TOKEN" \
  -F "name=My Tapis Job" \
  -F "images=@image1.jpg" \
  -F "images=@image2.jpg"
```

### 3. Monitor Job Status

Jobs can be monitored through ClusterODM's normal web interface at `http://localhost:3000` or the administrative interface at `http://localhost:10000`.

## Job Lifecycle

1. **Task Submission**: User submits task with Tapis token
2. **File Upload**: Images are uploaded to Tapis storage system
3. **Job Submission**: Tapis job is submitted to the execution system
4. **Job Execution**: Job runs on TACC compute resources
5. **Result Archival**: Results are stored on Tapis storage system
6. **Cleanup**: Temporary files and job artifacts are cleaned up

## Tapis Job States

The integration maps Tapis job states to ClusterODM states:

- `PENDING`, `PROCESSING_INPUTS`, `STAGING_INPUTS`, `STAGING_JOB`, `SUBMITTING_JOB`, `QUEUED`, `RUNNING`, `ARCHIVING` → `RUNNING`
- `FINISHED` → `COMPLETED`
- `CANCELLED` → `CANCELED`
- `FAILED` → `FAILED`

## Troubleshooting

### Common Issues

1. **Token Validation Errors**: Ensure your Tapis JWT token is valid and not expired
2. **System Access Errors**: Verify you have access to the specified execution and storage systems
3. **File Upload Failures**: Check storage system permissions and disk quotas
4. **Job Submission Failures**: Verify application ID and system configuration

### Logs

ClusterODM logs include Tapis-specific information:
- Job submission details
- File upload progress
- Job status updates
- Error messages with Tapis API responses

### Debug Commands

```bash
# Check ClusterODM status
curl http://localhost:10000/info

# Check specific job status
curl http://localhost:3000/task/{task-uuid}/info

# Check job output
curl http://localhost:3000/task/{task-uuid}/output
```

## Performance Considerations

1. **File Transfer**: Large datasets may take significant time to upload to TACC storage
2. **Queue Times**: Jobs may experience queue delays on busy TACC systems
3. **Resource Limits**: Be mindful of TACC allocation limits and queue policies
4. **Concurrent Jobs**: Monitor the number of concurrent jobs to avoid overwhelming systems

## Security

1. **Token Management**: Store Tapis tokens securely and rotate them regularly
2. **Network Security**: Use HTTPS for all API communications
3. **File Permissions**: Ensure proper file permissions on Tapis storage systems
4. **Access Control**: Limit access to ClusterODM and Tapis credentials

## Support

For issues related to:
- **ClusterODM Integration**: Report issues on the ClusterODM GitHub repository
- **Tapis API**: Consult Tapis documentation or support channels
- **TACC Systems**: Contact TACC support for system-specific issues
