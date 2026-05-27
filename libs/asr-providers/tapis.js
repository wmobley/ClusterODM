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
const tapisTaskOptions = require('../tapisTaskOptions');

function getTaskOption(taskOptions, name) {
    if (!Array.isArray(taskOptions)) return null;
    for (const opt of taskOptions) {
        if (!opt || typeof opt !== 'object') continue;
        if (opt.name === name) return opt.value;
    }
    return null;
}

function normalizeJobToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

const DEFAULT_ACTIVE_JOB_STATUSES = [
    "PENDING",
    "PROCESSING_INPUTS",
    "STAGING_INPUTS",
    "STAGING_JOB",
    "STAGED",
    "SUBMITTING",
    "SUBMITTING_JOB",
    "QUEUED",
    "RUNNING",
    "ARCHIVING",
    "CLEANING_UP",
    "PAUSED",
    "BLOCKED"
];

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
                {"maxImages": 50, "jobCount": 1, "coresPerNode": 2, "memoryMB": 8192, "maxJobTime": "02:00:00"},
                {"maxImages": 200, "jobCount": 1, "coresPerNode": 4, "memoryMB": 16384, "maxJobTime": "04:00:00"},
                {"maxImages": 500, "jobCount": 1, "coresPerNode": 8, "memoryMB": 32768, "maxJobTime": "08:00:00"}
            ]
        }, userConfig);

        this.activeJobs = new Map();
        this.jobStatusCache = new Map();
        this.appQueueCache = null;
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

    buildJobLabel(imagesCount, taskOptions){
        const parts = [];

        const split = getTaskOption(taskOptions, 'split');
        if (split !== null && split !== undefined && split !== '') {
            parts.push(`s${split}`);
        }

        const overlap = getTaskOption(taskOptions, 'split-overlap');
        if (overlap !== null && overlap !== undefined && overlap !== '') {
            parts.push(`o${overlap}`);
        }

        const noAlign = getTaskOption(taskOptions, 'sm-no-align');
        if (noAlign === true || noAlign === 'true' || noAlign === 1 || noAlign === '1') {
            parts.push('noalign');
        }

        const prefix = normalizeJobToken(this.getConfig('job.namePrefix', ''));
        if (prefix) parts.unshift(prefix);

        return parts.filter(Boolean).join('-');
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

    getConfiguredDefaultAllocation(){
        return this.getConfig("scheduler.defaultAllocation",
            this.getConfig("allocation.defaultChargeCode",
                this.getConfig("allocation.default",
                    this.getConfig("job.defaultAllocation", "PT2050-DataX"))));
    }

    getDefaultQueue(imagesCount = null){
        const configuredQueue = this.getConfig("system.logicalQueue", "");
        if (configuredQueue) return configuredQueue;

        const props = imagesCount !== null ? (this.getJobPropertiesFor(imagesCount) || {}) : {};
        return props.logicalQueue || "vm-small";
    }

    getDefaultMaxMinutes(imagesCount = null){
        const props = imagesCount !== null ? (this.getJobPropertiesFor(imagesCount) || {}) : {};
        const configuredTime = props.maxJobTime || this.getConfig("job.maxJobTime", "01:00:00");
        return this.normalizeMaxMinutes(configuredTime, 60);
    }

    normalizeMaxMinutes(value, fallbackMinutes){
        let minutes;

        if (typeof value === 'string' && value.indexOf(':') !== -1) {
            minutes = this.parseJobTime(value);
        } else if (value !== undefined && value !== null && value !== '') {
            minutes = parseInt(value, 10);
        }

        if (!Number.isFinite(minutes) || minutes <= 0) minutes = fallbackMinutes;
        minutes = Math.max(1, Math.min(2880, minutes));
        return minutes;
    }

    normalizeQueueFilter(value){
        if (!value) return [];
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return [];
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return this.normalizeQueueFilter(parsed);
            } catch (_) {
                // Treat as comma-separated below.
            }
            return trimmed.split(',').map(v => v.trim()).filter(Boolean);
        }
        return [];
    }

    async getQueueOptions(token){
        const now = Date.now();
        if (this.appQueueCache &&
            (now - this.appQueueCache.timestamp) < 5 * 60 * 1000 &&
            (this.appQueueCache.source === 'app' || !token)) {
            return this.appQueueCache.queues;
        }

        let queues = this.normalizeQueueFilter(this.getConfig("system.queueFilter", []));
        let source = 'config';

        if (token) {
            try {
                const client = this.createApiClient(token);
                const appId = this.getConfig("app.appId");
                const appVersion = this.getConfig("app.appVersion");
                const response = await client.get(`/v3/apps/${appId}-${appVersion}`);
                const app = response.data && response.data.result ? response.data.result : {};
                const notes = typeof app.notes === 'string' ? JSON.parse(app.notes) : (app.notes || {});
                const appQueues = this.normalizeQueueFilter(notes.queueFilter || notes.queues || notes.logicalQueues);
                if (appQueues.length > 0) {
                    queues = appQueues;
                    source = 'app';
                }
            } catch (e) {
                logger.warn(`[TAPIS DEBUG] Could not read Tapis app queueFilter; using configured queue defaults: ${e.message}`);
            }
        }

        const defaultQueue = this.getDefaultQueue();
        if (defaultQueue && queues.indexOf(defaultQueue) === -1) queues.unshift(defaultQueue);
        queues = [...new Set(queues)];

        this.appQueueCache = {
            timestamp: now,
            source,
            queues
        };
        return queues;
    }

    async getClusterOptions(token){
        const defaultQueue = this.getDefaultQueue();
        const queues = await this.getQueueOptions(token);
        const maxMinutes = this.getDefaultMaxMinutes();

        return [
            {
                name: "tapis-queue",
                label: "Queue",
                type: "enum",
                value: defaultQueue,
                domain: queues.length > 0 ? queues : [defaultQueue],
                help: "TACC logical queue for the Tapis job."
            },
            {
                name: "tapis-allocation",
                label: "Allocation",
                type: "string",
                value: this.getConfiguredDefaultAllocation(),
                domain: "",
                help: "TACC allocation charge code for the Tapis job."
            },
            {
                name: "tapis-max-run-time",
                label: "Max Run Time",
                type: "int",
                value: `${maxMinutes}`,
                domain: "integer: 1 <= x <= 2880",
                help: "Maximum Tapis job runtime in minutes. Maximum is 2880 minutes."
            }
        ];
    }

    getEffectiveQueue(taskOptions, imagesCount = null){
        const selectedQueue = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-queue');
        if (selectedQueue !== null && selectedQueue !== undefined && String(selectedQueue).trim() !== '') {
            return String(selectedQueue).trim();
        }
        return this.getDefaultQueue(imagesCount);
    }

    getEffectiveMaxMinutes(taskOptions, imagesCount = null){
        const defaultMinutes = this.getDefaultMaxMinutes(imagesCount);
        const selectedMinutes = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-max-run-time');
        return this.normalizeMaxMinutes(selectedMinutes, defaultMinutes);
    }

    getEffectiveAllocation(taskOptions){
        const selectedAllocation = tapisTaskOptions.getTaskOption(taskOptions, 'tapis-allocation');
        if (selectedAllocation !== null && selectedAllocation !== undefined && String(selectedAllocation).trim() !== '') {
            return String(selectedAllocation).trim();
        }
        return this.getConfiguredDefaultAllocation();
    }

    getActiveJobStatuses(){
        let statuses = this.getConfig("activeJobStatuses", DEFAULT_ACTIVE_JOB_STATUSES);
        if (!Array.isArray(statuses)) statuses = [statuses];
        return new Set(statuses.map(status => String(status || '').toUpperCase()).filter(Boolean));
    }

    calculateNodeSubmissionPlan(imagesCount){
        const jobProps = this.getJobPropertiesFor(imagesCount) || {};
        const defaultNodeCount = this.getConfig("job.nodeCount", 1);
        const computeNodeCountRaw = jobProps.computeNodeCount ?? jobProps.nodeCount;
        const requestedNodeCount = Math.max(1, computeNodeCountRaw ?? defaultNodeCount ?? 1);

        const maxNodesPerJobRaw = this.getConfig("job.maxNodesPerJob", 1);
        const maxNodesPerJob = Math.max(1, parseInt(maxNodesPerJobRaw, 10) || 1);
        const nodesForJob = Math.max(1, Math.min(requestedNodeCount, maxNodesPerJob));
        const jobCountRaw = jobProps.jobCount ?? 1;
        const nodesToSubmit = Math.max(1, parseInt(jobCountRaw, 10) || 1);
        const tapisJobCountRaw = jobProps.tapisJobCount ?? jobProps.jobsPerSubmission ?? jobCountRaw;
        const jobsToSubmit = Math.max(1, parseInt(tapisJobCountRaw, 10) || 1);
        const totalWorkerNodes = Math.max(nodesToSubmit, nodesForJob);

        return {
            jobProps,
            requestedNodeCount,
            maxNodesPerJob,
            nodesToSubmit,
            nodesForJob,
            jobsToSubmit,
            totalWorkerNodes
        };
    }

    getRequestedNodeCount(imagesCount){
        return this.calculateNodeSubmissionPlan(imagesCount).requestedNodeCount;
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

    // Extract user information from Tapis JWT token
    extractUserFromToken(token) {
        if (!token || typeof token !== 'string') {
            return null;
        }

        try {
            // JWT tokens have 3 parts separated by dots: header.payload.signature
            const parts = token.split('.');
            if (parts.length !== 3) {
                return null;
            }

            // Decode the payload (second part)
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

            // Check token expiration
            const now = Math.floor(Date.now() / 1000); // Current time in seconds
            const exp = payload.exp; // Expiration time in seconds

            if (exp && now >= exp) {
                const expiredDate = new Date(exp * 1000);
                logger.warn(`JWT token expired at ${expiredDate.toISOString()}`);
                throw new Error(`JWT token expired at ${expiredDate.toISOString()}. Please login again.`);
            }

            // Extract user information from claims
            const username = payload['tapis/username'] || payload.username;
            const tenantId = payload['tapis/tenant_id'] || payload.tenant_id;
            const subject = payload.sub;

            if (username && tenantId) {
                return {
                    username,
                    tenantId,
                    subject: subject || `${username}@${tenantId}`,
                    fullUser: `${username}@${tenantId}`,
                    exp: exp,
                    expiresAt: exp ? new Date(exp * 1000) : null
                };
            }

            return null;
        } catch (e) {
            logger.warn(`Failed to decode JWT token: ${e.message}`);
            return null;
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

    getJobListItems(responseData){
        if (!responseData) return [];
        const result = responseData.result;
        if (Array.isArray(result)) return result;
        if (result && Array.isArray(result.jobs)) return result.jobs;
        if (result && Array.isArray(result.items)) return result.items;
        if (result && Array.isArray(result.records)) return result.records;
        if (result && Array.isArray(result.listing)) return result.listing;
        if (Array.isArray(responseData.jobs)) return responseData.jobs;
        if (Array.isArray(responseData.items)) return responseData.items;
        if (Array.isArray(responseData.records)) return responseData.records;
        return [];
    }

    getJobNextPage(responseData){
        if (!responseData || !responseData.result) return null;
        const result = responseData.result;
        if (typeof result !== 'object' || Array.isArray(result)) return null;
        return result.next || result.nextPage || result.next_page || result.links?.next || null;
    }

    getJobUniqueKey(job){
        if (!job || typeof job !== 'object') return null;
        return job.uuid || job.id || job.jobUuid || job.jobUUID || job.jobId || job.job_id || null;
    }

    getJobAppIds(job){
        if (!job || typeof job !== 'object') return [];

        return [
            job.appId,
            job.app_id,
            job.appID,
            job.applicationId,
            job.application_id,
            typeof job.app === 'string' ? job.app : null,
            job.app && job.app.id,
            job.app && job.app.appId
        ].filter(Boolean).map(value => String(value));
    }

    jobMatchesCluster(job){
        if (!job || typeof job !== 'object') return false;

        const configuredAppId = this.getConfig("app.appId");
        if (configuredAppId && this.getJobAppIds(job).indexOf(String(configuredAppId)) !== -1) return true;

        const tags = Array.isArray(job.tags) ? job.tags.join(' ') : '';
        const haystack = [
            job.name,
            job.jobName,
            job.description,
            job.notes,
            tags
        ].map(value => String(value || '').toLowerCase()).join(' ');

        return haystack.includes('clusterodm');
    }

    isActiveTapisJob(job){
        if (!job || typeof job !== 'object') return false;
        const status = String(job.status || job.state || "").toUpperCase();
        return this.getActiveJobStatuses().has(status);
    }

    async listUserJobs(token, limit = null){
        const client = this.createApiClient(token);
        const jobs = [];
        const seen = new Set();
        const pageLimit = parseInt(limit || this.getConfig("jobListLimit", 100), 10) || 100;
        const maxPages = parseInt(this.getConfig("jobListMaxPages", 10), 10) || 10;
        let skip = 0;
        let next = null;

        for (let page = 0; page < maxPages; page++){
            const params = { limit: pageLimit, skip };
            const response = next
                ? await client.get(next)
                : await client.get('/v3/jobs/list', { params });
            const items = this.getJobListItems(response.data);

            let added = 0;
            for (const job of items){
                const key = this.getJobUniqueKey(job);
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);
                jobs.push(job);
                added++;
            }

            next = this.getJobNextPage(response.data);

            if (next) {
                skip += pageLimit;
                continue;
            }
            if (items.length < pageLimit || added === 0) break;
            skip += pageLimit;
        }

        return jobs;
    }

    async countActiveJobsForToken(token){
        const jobs = await this.listUserJobs(token);
        const activeJobs = jobs.filter(job => this.jobMatchesCluster(job) && this.isActiveTapisJob(job));
        logger.info(`[TAPIS DEBUG] Active Tapis ClusterODM jobs for token: ${activeJobs.length} (listed=${jobs.length})`);
        return activeJobs.length;
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

    // Submit Tapis job without input data - starts NodeODM instance
    async submitJobWithoutData(token, jobId, imagesCount, taskOptions, submissionPlan = null){
        const client = this.createApiClient(token);

        const plan = submissionPlan || this.calculateNodeSubmissionPlan(imagesCount);
        const jobProps = plan.jobProps || {};
        const defaultCores = this.getConfig("job.coresPerNode", 1);
        const defaultMemory = this.getConfig("job.memoryMB", 4096);
        const logicalQueue = this.getEffectiveQueue(taskOptions, imagesCount);
        const allocation = this.getEffectiveAllocation(taskOptions);
        const maxMinutes = this.getEffectiveMaxMinutes(taskOptions, imagesCount);

        const requestedNodeCount = plan.requestedNodeCount;
        const nodesToSubmit = plan.nodesToSubmit;
        const jobsToSubmit = plan.jobsToSubmit || nodesToSubmit;
        const nodesForJob = plan.nodesForJob || 1;
        const maxNodesPerJob = plan.maxNodesPerJob;
        const totalWorkerNodes = plan.totalWorkerNodes || Math.max(nodesToSubmit, nodesForJob);

        if (requestedNodeCount > maxNodesPerJob) {
            logger.warn(`[TAPIS DEBUG] Requested ${requestedNodeCount} compute node(s) but configuration limits to ${maxNodesPerJob}; job will reserve ${nodesForJob}`);
        }

        logger.info(`[TAPIS DEBUG] Submission plan: totalNodeODM=${nodesToSubmit}, tapisJobs=${jobsToSubmit}, nodesPerJob=${nodesForJob}, requestedNodeCount=${requestedNodeCount}, maxNodesPerJob=${maxNodesPerJob}, queue=${logicalQueue}, allocation=${allocation}, maxMinutes=${maxMinutes}`);

        const submittedJobs = [];

        try {
            for (let i = 0; i < jobsToSubmit; i++){
                const jobIndex = i + 1;
                const baseJobName = jobsToSubmit > 1 ? `${jobId}-${jobIndex}` : jobId;
                const jobLabel = this.buildJobLabel(imagesCount, taskOptions);
                const jobName = jobLabel ? `${baseJobName}-${jobLabel}` : baseJobName;
                const replicasForJob = nodesForJob;
                const nodeMaxConcurrency = jobProps.maxConcurrency || jobProps.nodeMaxConcurrency || jobProps.coresPerNode || defaultCores || 1;

                const jobDefinition = {
                    name: `${jobName}`,
                    description: `ClusterODM NodeODM instance for ${imagesCount} images (waiting for data) [${jobIndex}/${jobsToSubmit}]${jobLabel ? ` [${jobLabel}]` : ''}`,
                    appId: this.getConfig("app.appId"),
                    appVersion: this.getConfig("app.appVersion"),
                    execSystemId: this.getConfig("system.executionSystemId"),
                    execSystemLogicalQueue: logicalQueue,
                    archiveSystemId: this.getConfig("system.archiveSystemId"),
                    nodeCount: nodesForJob,
                    coresPerNode: jobProps.coresPerNode || defaultCores || 1,
                    memoryMB: jobProps.memoryMB || defaultMemory || 4096,
                    maxMinutes,
                    archiveOnAppError: this.getConfig("job.archiveOnAppError", true),
                    parameterSet: {
                        appArgs: [
                            { arg: `${nodeMaxConcurrency}`, name: "max_concurrency", description: "Maximum number of concurrent processing tasks" },
                            { arg: "3001", name: "nodeodm_port", description: "NodeODM service port" },
                            { arg: "https://clusterodm.tacc.utexas.edu", name: "clusterodm_url", description: "ClusterODM URL for registration" }
                        ],
                        schedulerOptions: [
                            { arg: `-A ${allocation}`, name: "TACC Allocation", description: "The TACC allocation associated with this job execution" }
                        ],
                        envVariables: [
                            { key: "NODEODM_REPLICAS_PER_JOB", value: `${replicasForJob}` },
                            { key: "NODEODM_TOTAL_VIRTUAL_NODES", value: `${totalWorkerNodes}` },
                            { key: "NODEODM_JOB_INDEX", value: `${jobIndex}` },
                            { key: "NODEODM_JOB_COUNT", value: `${jobsToSubmit}` }
                        ]
                    },
                    // No fileInputs - NodeODM will start and wait for data from ClusterODM
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
                logger.debug(`[TAPIS DEBUG] Job definition being submitted (no input data) [${jobIndex}/${jobsToSubmit}]:`, JSON.stringify(jobDefinition, null, 2));
                logger.debug(`[TAPIS DEBUG] Submitting to endpoint: ${this.getConfig("tapis.baseUrl")}/v3/jobs/submit`);

                const response = await client.post('/v3/jobs/submit', jobDefinition, {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                const tapisJobId = response.data.result.uuid;

                logger.info(`[TAPIS DEBUG] Successfully submitted Tapis job ${tapisJobId} for ClusterODM task ${jobId} (${jobName}) [${jobIndex}/${jobsToSubmit}]`);
                logger.debug(`[TAPIS DEBUG] Full response:`, JSON.stringify(response.data, null, 2));

                const jobRecord = {
                    jobName,
                    tapisJobId,
                    baseJobId: jobId,
                    index: jobIndex,
                    requestedNodeCount,
                    nodesToSubmit: nodesForJob,
                    totalWorkerNodes
                };

                submittedJobs.push(jobRecord);

                this.activeJobs.set(tapisJobId, jobRecord);
            }

            if (submittedJobs.length === 0){
                throw new Error('Failed to submit any Tapis jobs');
            }

            return {
                primaryJobId: submittedJobs[0]?.tapisJobId || null,
                submittedJobs,
                requestedNodeCount,
                nodesToSubmit,
                jobsToSubmit,
                nodesPerJob: nodesForJob,
                totalWorkerNodes
            };
        } catch (e) {
            const errorMsg = e.response?.data?.message || e.message;
            logger.error(`[TAPIS DEBUG] Failed to submit job. Error details:`, {
                status: e.response?.status,
                statusText: e.response?.statusText,
                data: e.response?.data,
                message: e.message
            });

            // Attempt to cancel any jobs that were already submitted in this batch
            for (const job of submittedJobs){
                try {
                    await this.cancelJob(token, job.tapisJobId);
                } catch (cancelErr) {
                    logger.warn(`[TAPIS DEBUG] Failed to cancel partially submitted job ${job.tapisJobId}: ${cancelErr.message}`);
                } finally {
                    this.activeJobs.delete(job.tapisJobId);
                }
            }

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
        if (typeof timeStr === 'number') return Math.ceil(timeStr);
        if (!timeStr || typeof timeStr !== 'string') return 0;
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

    // Store pending tasks waiting for NodeODM registration
    pendingTasks = new Map();

    // Override createNode to just submit Tapis job and wait for NodeODM registration
    async createNode(req, imagesCount, token, hostname, status, taskOptions, fileNames, tmpPath, clusterTaskId = null, pathImport = null){
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
        logger.info(`[TAPIS DEBUG] Submitting Tapis job for ${imagesCount} images with ID ${jobId} (no virtual node)`);

        const submissionPlan = this.calculateNodeSubmissionPlan(imagesCount);
        const nodesToSubmit = submissionPlan.nodesToSubmit || 1;
        const jobsToSubmit = submissionPlan.jobsToSubmit || nodesToSubmit;

        const nodesReserved = nodesToSubmit;

        try {
            this.nodesPendingCreation += nodesReserved;

            // Check if we've reached the job limit
            const machineLimit = this.getMachinesLimit();
            if (machineLimit !== -1) {
                let activeJobCount;
                try {
                    activeJobCount = await this.countActiveJobsForToken(token);
                } catch (e) {
                    throw new Error(`Could not count active Tapis jobs for job limit check: ${e.message}`);
                }
                if ((activeJobCount + jobsToSubmit) > machineLimit) {
                    throw new Error(`Job limit reached (${machineLimit}). Active: ${activeJobCount}, requested: ${jobsToSubmit}`);
                }
            }

            // Submit Tapis job directly without creating virtual TapisNode (no file upload yet)
            const submissionResult = await this.submitJobWithoutData(token, jobId, imagesCount, taskOptions, submissionPlan);
            const tapisJobId = submissionResult.primaryJobId;

            if (!tapisJobId) {
                throw new Error('Failed to determine Tapis job ID after submission');
            }

            // Extract user information from token for ownership tracking
            // Try to get user from request headers first (job owner), then fall back to JWT token
            let nodeUser = null;

            // Check if request has job owner info (preferred method)
            const jobOwner = req.headers['x-tapis-job-owner'] || req.body?.tapisJobOwner;
            if (jobOwner) {
                nodeUser = `${jobOwner}@portals`; // Assume portals tenant
                logger.info(`Using job owner for user tracking: ${nodeUser}`);
            } else {
                // Fall back to JWT token extraction
                const userInfo = this.extractUserFromToken(token);
                nodeUser = userInfo ? userInfo.fullUser : null;
                if (nodeUser) {
                    logger.info(`Using JWT token for user tracking: ${nodeUser}`);
                }
            }

            // Store pending task data for when NodeODM registers (keep files local)
            const clusterTaskUuid = clusterTaskId || require('crypto').randomUUID();
            const effectiveQueue = this.getEffectiveQueue(taskOptions, imagesCount);
            const nodeTaskOptions = tapisTaskOptions.applyGpuQueuePolicy(taskOptions, effectiveQueue);

            // Mark tmp directory as protected from cleanup (if tmpPath exists)
            if (tmpPath) {
                const fs = require('fs');
                const lockFile = tmpPath + '/.tapis_pending_task';
                try {
                    fs.writeFileSync(lockFile, JSON.stringify({
                        tapisJobId,
                        taskId: clusterTaskUuid,
                        clusterTaskId: clusterTaskUuid,
                        timestamp: Date.now(),
                        protected: true
                    }));
                    logger.info(`[TAPIS DEBUG] Protected tmp directory: ${tmpPath}`);
                } catch (e) {
                    logger.warn(`Could not create protection lock file: ${e.message}`);
                }
            }

            this.pendingTasks.set(tapisJobId, {
                taskId: clusterTaskUuid,
                clusterTaskId: clusterTaskUuid,
                jobId,
                imagesCount,
                taskOptions: nodeTaskOptions,
                tapisOptions: taskOptions,
                fileNames,
                tmpPath,
                token,
                tapisJobId,
                nodeUser,
                req,
                pathImport,
                submittedJobs: submissionResult.submittedJobs,
                nodesPerJob: submissionResult.nodesPerJob || submissionPlan.nodesForJob || 1,
                totalWorkerNodes: submissionResult.totalWorkerNodes || submissionPlan.totalWorkerNodes || nodesToSubmit
            });

            logger.info(`[TAPIS DEBUG] Tapis job ${tapisJobId} submitted, task ${clusterTaskUuid} pending NodeODM registration (files kept local)`);
            if (submissionResult.submittedJobs && submissionResult.submittedJobs.length > 1) {
                const additionalJobs = submissionResult.submittedJobs.slice(1).map(job => job.tapisJobId).join(', ');
                logger.info(`[TAPIS DEBUG] Additional Tapis jobs submitted for capacity: ${additionalJobs}`);
            }
            logger.info(`[TAPIS DEBUG] Stored pending task - pendingTasks.size: ${this.pendingTasks.size}`);
            logger.info(`[TAPIS DEBUG] Pending task keys: ${Array.from(this.pendingTasks.keys()).join(', ')}`);

            // Don't create any node - just wait for real NodeODM to register
            logger.info(`[TAPIS DEBUG] No placeholder node created - waiting for real NodeODM to register with UUID ${tapisJobId}`);
            return null;
        } catch (e) {
            logger.error(`Failed to create Tapis node: ${e.message}`);
            throw e;
        } finally {
            this.nodesPendingCreation -= nodesReserved;
        }
    }

    // Override destroyNode to cancel Tapis job
    async destroyNode(node){
        if (node.isAutoSpawned() && node instanceof TapisNode){
            logger.debug(`Destroying Tapis job for node ${node}`);
            try {
                await node.cancelJob();
                // Remove from activeJobs map to prevent counting against limit
                this.activeJobs.delete(node.tapisJobId || node.jobId);
                logger.info(`Cleaned up Tapis node ${node.jobId} from active jobs`);
            } catch (e) {
                logger.warn(`Failed to cancel Tapis job for ${node}: ${e.message}`);
                // Still remove from activeJobs to prevent hanging
                this.activeJobs.delete(node.tapisJobId || node.jobId);
            }
        } else {
            logger.warn(`Tried to call destroyNode on a non-Tapis node: ${node}`);
        }
    }

    // Not used for Tapis (no docker-machine)
    async getCreateArgs(imagesCount, attempt){
        return [];
    }

    async _ensureDir(dirPath){
        await fs.promises.mkdir(dirPath, { recursive: true });
    }

    async _downloadDirectory(client, archiveSystemId, remotePath, localPath){
        await this._ensureDir(localPath);

        const listResponse = await client.get(`/v3/files/listings/${archiveSystemId}${remotePath}`);
        const entries = listResponse.data.result || [];

        for (const entry of entries){
            const remoteEntryPath = `${remotePath}/${entry.name}`;
            const localEntryPath = path.join(localPath, entry.name);

            if (entry.type === 'dir' || entry.type === 'directory'){
                await this._downloadDirectory(client, archiveSystemId, remoteEntryPath, localEntryPath);
            } else if (entry.type === 'file'){
                const downloadResponse = await client.get(
                    `/v3/files/content/${archiveSystemId}${remoteEntryPath}`,
                    { responseType: 'stream' }
                );

                await this._ensureDir(path.dirname(localEntryPath));
                const writeStream = fs.createWriteStream(localEntryPath);
                downloadResponse.data.pipe(writeStream);

                await new Promise((resolve, reject) => {
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });

                logger.debug(`Downloaded file: ${remoteEntryPath}`);
            }
        }
    }

    // Download job results from Tapis storage
    async downloadJobResults(token, jobId, tapisJobId, outputPath){
        const client = this.createApiClient(token);
        const archiveSystemId = this.getConfig("system.archiveSystemId");
        const jobOutputPath = `/jobs/${jobId}/outputs`;

        try {
            await this._downloadDirectory(client, archiveSystemId, jobOutputPath, outputPath);
            logger.info(`Successfully downloaded all output files for job ${jobId}`);
            return jobOutputPath;
        } catch (e) {
            throw new Error(`Failed to download job results: ${e.response?.data?.message || e.message}`);
        }
    }

    async downloadJobFile(token, jobId, tapisJobId, remoteFileName, destinationPath){
        const client = this.createApiClient(token);
        const archiveSystemId = this.getConfig("system.archiveSystemId");
        const remotePath = `/jobs/${jobId}/outputs/${remoteFileName}`;

        try {
            await this._ensureDir(path.dirname(destinationPath));

            const response = await client.get(
                `/v3/files/content/${archiveSystemId}${remotePath}`,
                { responseType: 'stream' }
            );

            const writeStream = fs.createWriteStream(destinationPath);
            response.data.pipe(writeStream);

            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            logger.info(`Downloaded ${remoteFileName} for job ${jobId}`);
            return destinationPath;
        } catch (e) {
            const status = e.response?.status;
            const message = e.response?.data?.message || e.message;
            throw new Error(`Failed to download ${remoteFileName} from Tapis (status ${status || 'n/a'}): ${message}`);
        }
    }

    // Not used for Tapis (no machine setup)
    async setupMachine(req, token, dm, nodeToken){
        // No-op for Tapis
    }
};
