/**
 *  ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM
 *  Copyright (C) 2018-present MasseranoLabs LLC
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const AbstractASRProvider = require('../classes/AbstractASRProvider');
const logger = require('../logger');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TapisNode = require('../classes/TapisNode');

module.exports = class TapisAsrProvider extends AbstractASRProvider{
    constructor(userConfig){
        super({
            "tapis": {
                "baseUrl": "https://tacc.tapis.io",
                "tenantId": "tacc"
            },
            "app": {
                "appId": "nodeodm-app",
                "appVersion": "1.0"
            },
            "system": {
                "executionSystemId": "CHANGEME!",
                "archiveSystemId": "CHANGEME!"
            },
            "job": {
                "maxJobTime": "01:00:00",
                "nodeCount": 1,
                "coresPerNode": 1,
                "memoryMB": 4096,
                "archiveOnAppError": true
            },
            "maxRuntime": -1,
            "maxUploadTime": 3600,
            "jobLimit": -1,
            "createRetries": 3,
            "imageSizeMapping": [
                {"maxImages": 50, "nodeCount": 1, "coresPerNode": 2, "memoryMB": 8192, "maxJobTime": "02:00:00"},
                {"maxImages": 200, "nodeCount": 1, "coresPerNode": 4, "memoryMB": 16384, "maxJobTime": "04:00:00"},
                {"maxImages": 500, "nodeCount": 1, "coresPerNode": 8, "memoryMB": 32768, "maxJobTime": "08:00:00"}
            ]
        }, userConfig);

        this.activeJobs = new Map();
        this.jobStatusCache = new Map();
    }

    async initialize(){
        this.validateConfigKeys([
            "tapis.baseUrl", 
            "tapis.tenantId",
            "app.appId",
            "app.appVersion", 
            "system.executionSystemId",
            "system.archiveSystemId"
        ]);

        const im = this.getConfig("imageSizeMapping", []);
        if (!Array.isArray(im)) throw new Error("Invalid config key imageSizeMapping (array expected)");

        // Sort by ascending maxImages
        im.sort((a, b) => {
            if (a['maxImages'] < b['maxImages']) return -1;
            else if (a['maxImages'] > b['maxImages']) return 1;
            else return 0;
        });

        logger.info("Tapis ASR Provider initialized");
    }

    getDriverName(){
        return "tapis";
    }

    getMachinesLimit(){
        const limit = this.getConfig("jobLimit", -1);
        logger.info(`[TAPIS DEBUG] Machine limit: ${limit}`);
        return limit;
    }

    getCreateRetries(){
        return this.getConfig("createRetries", 3);
    }

    getDownloadsBaseUrl(){
        // Files will be accessed through Tapis Files API
        return `${this.getConfig("tapis.baseUrl")}/v3/files`;
    }

    canHandle(imagesCount){
        const props = this.getJobPropertiesFor(imagesCount);
        logger.info(`[TAPIS DEBUG] canHandle check: imagesCount=${imagesCount}, props=${props ? 'found' : 'null'}`);
        if (props) {
            logger.info(`[TAPIS DEBUG] Job properties for ${imagesCount} images:`, JSON.stringify(props));
        }
        return props !== null;
    }

    getJobPropertiesFor(imagesCount){
        const im = this.getConfig("imageSizeMapping");
        logger.info(`[TAPIS DEBUG] getJobPropertiesFor: imagesCount=${imagesCount}, imageSizeMapping has ${im ? im.length : 0} entries`);

        let props = null;
        for (let k in im){
            const mapping = im[k];
            logger.info(`[TAPIS DEBUG] Checking mapping ${k}: maxImages=${mapping['maxImages']}, imagesCount=${imagesCount}`);
            if (mapping['maxImages'] >= imagesCount){
                props = mapping;
                logger.info(`[TAPIS DEBUG] Found matching mapping:`, JSON.stringify(props));
                break;
            }
        }

        if (!props) {
            logger.warn(`[TAPIS DEBUG] No mapping found for ${imagesCount} images`);
        }

        return props;
    }

    getMaxRuntime(){
        return this.getConfig("maxRuntime");
    }

    getMaxUploadTime(){
        return this.getConfig("maxUploadTime");
    }

    // Validate Tapis token
    async validateToken(token){
        if (!token || typeof token !== 'string') {
            throw new Error('Invalid Tapis token provided');
        }

        // Try a simple API call to validate the token
        const client = this.createApiClient(token);
        try {
            await client.get('/v3/systems');
            return true;
        } catch (e) {
            if (e.response && e.response.status === 401) {
                throw new Error('Tapis token is invalid or expired');
            }
            throw new Error(`Failed to validate Tapis token: ${e.message}`);
        }
    }

    // Create API client with authentication
    createApiClient(token){
        if (!token) {
            throw new Error('Tapis token is required');
        }

        return axios.create({
            baseURL: this.getConfig("tapis.baseUrl"),
            headers: {
                'X-Tapis-Token': token
            },
            timeout: 300000, // 5 minutes for large file transfers
            maxRedirects: 5
        });
    }

    // Upload files to Tapis storage system
    async uploadFiles(token, fileNames, tmpPath, jobId){
        const client = this.createApiClient(token);
        const archiveSystemId = this.getConfig("system.archiveSystemId");
        // Upload to SCRATCH directory path
        const uploadPath = `scratch/06659/wmobley/clusterodm/jobs/${jobId}/inputs`;

        logger.info(`Uploading ${fileNames.length} files to Tapis storage for job ${jobId}`);
        
        // Mark this temp directory as actively being used to prevent cleanup
        const fs = require('fs');
        const lockFile = tmpPath + '/.tapis_upload_in_progress';
        try {
            fs.writeFileSync(lockFile, Date.now().toString());
        } catch (e) {
            logger.warn(`Could not create upload lock file: ${e.message}`);
        }

        // Skip creating directory - let Tapis create it automatically during upload
        logger.info(`Using upload path: ${uploadPath} (directories will be created automatically)`);

        // Upload files directly from original tmpPath directory
        logger.info(`[TAPIS DEBUG] Using original tmp directory: ${tmpPath}`);
        
        // Wait a moment for file system to stabilize, then verify files exist
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Debug: Show what's actually in the directory before we start checking
        try {
            const allFiles = fs.readdirSync(tmpPath);
            logger.info(`[TAPIS DEBUG] Directory contents before verification: ${allFiles.join(', ')}`);
        } catch (e) {
            logger.error(`[TAPIS DEBUG] Cannot list directory before verification: ${e.message}`);
        }
        
        // Verify original files exist 
        const uploadFiles = [];
        for (const fileName of fileNames) {
            const originalPath = path.join(tmpPath, fileName);
            
            // Try multiple times with delays to handle file system timing issues
            let fileExists = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (fs.existsSync(originalPath)) {
                    fileExists = true;
                    break;
                }
                logger.warn(`[TAPIS DEBUG] File not found on attempt ${attempt + 1}, waiting: ${originalPath}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            if (!fileExists) {
                logger.error(`[TAPIS DEBUG] Original file does not exist after retries: ${originalPath}`);
                
                // List what files DO exist for debugging
                try {
                    const existingFiles = fs.readdirSync(tmpPath);
                    logger.error(`[TAPIS DEBUG] Files in ${tmpPath}: ${existingFiles.join(', ')}`);
                } catch (e) {
                    logger.error(`[TAPIS DEBUG] Cannot list directory ${tmpPath}: ${e.message}`);
                }
                
                throw new Error(`Original file not found: ${originalPath}`);
            }
            
            uploadFiles.push(fileName);
            logger.info(`[TAPIS DEBUG] Confirmed original file exists: ${fileName} (size: ${fs.statSync(originalPath).size} bytes)`);
        }
        
        logger.info(`[TAPIS DEBUG] Successfully found all ${uploadFiles.length} original files`);

        // Upload each file sequentially from original directory
        for (const fileName of uploadFiles) {
            const filePath = path.join(tmpPath, fileName);
            
            let uploadRetries = 0;
            const MAX_RETRIES = 3;
            
            while (uploadRetries <= MAX_RETRIES) {
                try {
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('file', fs.createReadStream(filePath));
                    
                    await client.post(
                        `/v3/files/ops/${archiveSystemId}/${uploadPath}/${fileName}`,
                        form,
                        {
                            headers: {
                                ...form.getHeaders()
                            },
                            maxBodyLength: Infinity,
                            maxContentLength: Infinity,
                            timeout: 600000 // 10 minutes for file uploads
                        }
                    );
                    logger.debug(`Uploaded file: ${fileName}`);
                    break; // Success, exit retry loop
                    
                } catch (e) {
                    uploadRetries++;
                    logger.error(`Upload error for ${fileName} (attempt ${uploadRetries}): ${e.code} - ${e.message}`);
                    
                    if (e.response) {
                        logger.error(`Response status: ${e.response.status}, data: ${JSON.stringify(e.response.data)}`);
                    }
                    
                    // Retry on socket hang up or timeout errors
                    if ((e.code === 'ECONNRESET' || e.code === 'ENOTFOUND' || e.message.includes('socket hang up') || e.message.includes('timeout')) && uploadRetries <= MAX_RETRIES) {
                        logger.warn(`Retrying upload for ${fileName} in 5 seconds (attempt ${uploadRetries}/${MAX_RETRIES})`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }
                    
                    // Clean up on upload failure
                    try {
                        const utils = require('../utils');
                        utils.rmdir(tmpPath);
                        logger.info(`[TAPIS DEBUG] Cleaned up tmp directory after upload failure: ${tmpPath}`);
                    } catch (cleanupError) {
                        logger.warn(`Could not clean up tmp directory on failure: ${cleanupError.message}`);
                    }
                    
                    throw new Error(`Failed to upload file ${fileName}: ${e.response?.data?.message || e.message}`);
                }
            }
        }

        logger.info(`Successfully uploaded all files for job ${jobId}`);
        
        // Remove upload lock file
        try {
            fs.unlinkSync(lockFile);
        } catch (e) {
            logger.warn(`Could not remove upload lock file: ${e.message}`);
        }
        
        // Clean up original tmp directory after successful upload
        try {
            const utils = require('../utils');
            utils.rmdir(tmpPath);
            logger.info(`[TAPIS DEBUG] Cleaned up tmp directory after successful upload: ${tmpPath}`);
        } catch (e) {
            logger.warn(`Could not clean up tmp directory: ${e.message}`);
        }
        
        return uploadPath;
    }

    // Submit Tapis job
    async submitJob(token, jobId, inputPath, imagesCount, taskOptions){
        const client = this.createApiClient(token);
        const jobProps = this.getJobPropertiesFor(imagesCount);
        
        const jobDefinition = {
            name: `${jobId}`,
            description: `ClusterODM NodeODM processing job for ${imagesCount} images`,
            appId: this.getConfig("app.appId"),
            appVersion: this.getConfig("app.appVersion"),
            execSystemId: this.getConfig("system.executionSystemId"),
            execSystemLogicalQueue: "vm-small",
            archiveSystemId: this.getConfig("system.archiveSystemId"),
            nodeCount: jobProps.nodeCount || 1,
            coresPerNode: jobProps.coresPerNode || 1,
            memoryMB: jobProps.memoryMB || 4096,
            maxMinutes: this.parseJobTime(jobProps.maxJobTime || "01:00:00"),
            archiveOnAppError: this.getConfig("job.archiveOnAppError", true),
            parameterSet: {
                appArgs: [
                    { arg: "4", name: "max_concurrency", description: "Maximum number of concurrent processing tasks" },
                    { arg: "3001", name: "nodeodm_port", description: "NodeODM service port" }
                ],
                schedulerOptions: [
                    { arg: `-A PT2050-DataX`, name: "TACC Allocation", description: "The TACC allocation associated with this job execution" }
                ]
            },
            fileInputs: [{
                name: "inputImages",
                description: "Input images for ODM processing",
                sourceUrl: `tapis://${this.getConfig("system.archiveSystemId")}/${inputPath}`,
                targetPath: "inputs"
            }],
            subscriptions: [{
                enabled: true,
                ttlMinutes: 10080,
                description: "Portal job status notification",
                deliveryTargets: [{
                    deliveryMethod: "WEBHOOK",
                    deliveryAddress: "https://ptdatax.tacc.utexas.edu/webhooks/jobs/"
                }],
                eventCategoryFilter: "JOB_NEW_STATUS"
            }],
            tags: ["portalName: PTDATAX"]
        };
        logger.debug(`[TAPIS DEBUG] Job definition being submitted:`, JSON.stringify(jobDefinition, null, 2));
        logger.debug(`[TAPIS DEBUG] Submitting to endpoint: ${this.getConfig("tapis.baseUrl")}/v3/jobs/submit`);

        try {
            const response = await client.post('/v3/jobs/submit', jobDefinition, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            const tapisJobId = response.data.result.uuid;
            
            logger.info(`[TAPIS DEBUG] Successfully submitted Tapis job ${tapisJobId} for ClusterODM task ${jobId}`);
            logger.debug(`[TAPIS DEBUG] Full response:`, JSON.stringify(response.data, null, 2));
            this.activeJobs.set(jobId, tapisJobId);
            
            return tapisJobId;
        } catch (e) {
            const errorMsg = e.response?.data?.message || e.message;
            logger.error(`[TAPIS DEBUG] Failed to submit job. Error details:`, {
                status: e.response?.status,
                statusText: e.response?.statusText,
                data: e.response?.data,
                message: e.message
            });
            throw new Error(`Failed to submit Tapis job: ${errorMsg}`);
        }
    }

    // Build application arguments for NodeODM processing
    buildAppArgs(taskOptions, inputPath){
        const args = [];
        
        // NodeODM app expects input and output directories
        args.push({ arg: '/inputs' });
        args.push({ arg: '/outputs' });
        
        // TODO: Add ODM processing options based on taskOptions
        // For now, keep simple to get basic functionality working
        
        return args;
    }

    // Parse job time format (HH:MM:SS) to minutes
    parseJobTime(timeStr){
        const parts = timeStr.split(':');
        const hours = parseInt(parts[0]) || 0;
        const minutes = parseInt(parts[1]) || 0;
        const seconds = parseInt(parts[2]) || 0;
        
        return hours * 60 + minutes + Math.ceil(seconds / 60);
    }

    // Get job status from Tapis
    async getJobStatus(token, tapisJobId){
        // Check cache first (cache for 10 seconds to reduce API calls)
        const cacheKey = tapisJobId;
        const cached = this.jobStatusCache.get(cacheKey);
        const now = Date.now();
        
        if (cached && (now - cached.timestamp) < 10000) {
            return cached.status;
        }

        const client = this.createApiClient(token);
        
        try {
            const response = await client.get(`/v3/jobs/${tapisJobId}`);
            const status = response.data.result.status;
            
            // Cache the status
            this.jobStatusCache.set(cacheKey, {
                status: status,
                timestamp: now
            });
            
            return status;
        } catch (e) {
            logger.error(`Failed to get job status for ${tapisJobId}: ${e.message}`);
            return 'UNKNOWN';
        }
    }

    // Cancel Tapis job
    async cancelJob(token, tapisJobId){
        const client = this.createApiClient(token);
        
        try {
            await client.post(`/v3/jobs/${tapisJobId}/cancel`);
            logger.info(`Cancelled Tapis job ${tapisJobId}`);
        } catch (e) {
            logger.error(`Failed to cancel job ${tapisJobId}: ${e.message}`);
            throw e;
        }
    }

    // Override createNode to submit Tapis job instead of creating VM
    async createNode(req, imagesCount, token, hostname, status){
        logger.info(`[TAPIS DEBUG] createNode called with imagesCount: ${imagesCount}, hostname: ${hostname}`);
        
        if (!this.canHandle(imagesCount)) {
            logger.error(`[TAPIS DEBUG] Cannot handle ${imagesCount} images`);
            throw new Error(`Cannot handle ${imagesCount} images.`);
        }

        // Token must be provided from request - no fallback to config
        if (!token || token === 'missing') {
            throw new Error('Tapis JWT token must be provided in request headers (Authorization: Bearer <token>) or query parameters (?token=<token>)');
        }

        // Validate token first
        try {
            logger.info(`[TAPIS DEBUG] Validating token...`);
            await this.validateToken(token);
            logger.info(`[TAPIS DEBUG] Token validation successful`);
        } catch (e) {
            logger.error(`[TAPIS DEBUG] Token validation failed: ${e.message}`);
            throw new Error(`Token validation failed: ${e.message}`);
        }

        const jobId = hostname; // Use hostname as job identifier
        logger.info(`Creating Tapis job for ${imagesCount} images with ID ${jobId}`);

        try {
            this.nodesPendingCreation++;

            // Check if we've reached the job limit
            if (this.getMachinesLimit() !== -1 && this.activeJobs.size >= this.getMachinesLimit()) {
                throw new Error(`Job limit reached (${this.getMachinesLimit()})`);
            }

            // Create TapisNode instance
            const node = new TapisNode(jobId, token, this);
            
            // Mark as auto-spawned
            node.setDockerMachine(jobId, this.getMaxRuntime(), this.getMaxUploadTime());
            
            logger.info(`Successfully created Tapis node ${jobId}`);
            return node;
        } catch (e) {
            logger.error(`Failed to create Tapis node: ${e.message}`);
            throw e;
        } finally {
            this.nodesPendingCreation--;
        }
    }

    // Override destroyNode to cancel Tapis job
    async destroyNode(node){
        if (node.isAutoSpawned() && node instanceof TapisNode){
            logger.debug(`Destroying Tapis job for node ${node}`);
            try {
                await node.cancelJob();
                // Remove from activeJobs map to prevent counting against limit
                this.activeJobs.delete(node.jobId);
                logger.info(`Cleaned up Tapis node ${node.jobId} from active jobs`);
            } catch (e) {
                logger.warn(`Failed to cancel Tapis job for ${node}: ${e.message}`);
                // Still remove from activeJobs to prevent hanging
                this.activeJobs.delete(node.jobId);
            }
        } else {
            logger.warn(`Tried to call destroyNode on a non-Tapis node: ${node}`);
        }
    }

    // Not used for Tapis (no docker-machine)
    async getCreateArgs(imagesCount, attempt){
        return [];
    }

    // Download job results from Tapis storage
    async downloadJobResults(token, jobId, tapisJobId, outputPath){
        const client = this.createApiClient(token);
        const archiveSystemId = this.getConfig("system.archiveSystemId");
        const jobOutputPath = `/jobs/${jobId}/outputs`;

        try {
            // List files in output directory
            const listResponse = await client.get(`/v3/files/listings/${archiveSystemId}${jobOutputPath}`);
            const files = listResponse.data.result;

            if (!files || files.length === 0) {
                throw new Error('No output files found');
            }

            // Download each file
            for (const file of files) {
                if (file.type === 'file') {
                    const downloadResponse = await client.get(
                        `/v3/files/content/${archiveSystemId}${jobOutputPath}/${file.name}`,
                        { responseType: 'stream' }
                    );

                    const outputFilePath = path.join(outputPath, file.name);
                    const writeStream = fs.createWriteStream(outputFilePath);
                    
                    downloadResponse.data.pipe(writeStream);
                    
                    await new Promise((resolve, reject) => {
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });

                    logger.debug(`Downloaded file: ${file.name}`);
                }
            }

            logger.info(`Successfully downloaded all output files for job ${jobId}`);
            return jobOutputPath;
        } catch (e) {
            throw new Error(`Failed to download job results: ${e.response?.data?.message || e.message}`);
        }
    }

    // Not used for Tapis (no machine setup)
    async setupMachine(req, token, dm, nodeToken){
        // No-op for Tapis
    }
};