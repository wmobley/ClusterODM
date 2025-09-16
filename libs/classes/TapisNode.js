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
const Node = require('./Node');
const logger = require('../logger');
const statusCodes = require('../statusCodes');

module.exports = class TapisNode extends Node{
    constructor(jobId, token, tapisProvider){
        // Use jobId as hostname and a dummy port
        super(jobId, 3000, '');

        this.jobId = jobId;
        this.tapisToken = token;
        this.tapisProvider = tapisProvider;
        this.tapisJobId = null;
        this.jobSubmitted = false;
        this.inputPath = null;
        this.currentTask = null;
        this.pendingTaskData = null; // Store task data until node is ready
        this.nodeRegistered = false; // Track if actual NodeODM has registered
        
        // Override node info with job-specific info
        this.nodeData.info = {
            version: '1.0.0',
            taskQueueCount: 0,
            maxParallelTasks: 1,
            totalMemory: 0,
            availableMemory: 0,
            cpuCores: 1,
            maxImages: 1000,
            engine: 'ODM',
            engineVersion: 'latest'
        };
        
        this.nodeData.lastRefreshed = new Date().getTime();
    }

    // Override updateInfo to check job status instead of HTTP call
    async updateInfo(){
        try {
            // If real NodeODM is registered, get info from it
            if (this.nodeRegistered && this.hostname && this.port) {
                const axios = require('axios');
                const nodeUrl = `http://${this.hostname}:${this.port}`;
                const tokenParam = this.token ? `?token=${this.token}` : '';

                const response = await axios.get(`${nodeUrl}/info${tokenParam}`, { timeout: 5000 });
                this.nodeData.info = response.data;
                this.nodeData.lastRefreshed = new Date().getTime();
                return;
            }

            // If waiting for registration, show as offline
            if (this.waitingForRegistration) {
                this.nodeData.info.taskQueueCount = 0;
                this.nodeData.lastRefreshed = new Date().getTime();
                return;
            }

            // Legacy behavior: check Tapis job status
            if (this.tapisJobId) {
                const status = await this.tapisProvider.getJobStatus(this.tapisToken, this.tapisJobId);
                this.updateInfoFromJobStatus(status);
            } else if (this.currentTask) {
                this.nodeData.info.taskQueueCount = 1;
            }

            this.nodeData.lastRefreshed = new Date().getTime();
        } catch (e) {
            logger.warn(`Cannot update info for Tapis node ${this.jobId}: ${e.message}`);
            this.nodeData.lastRefreshed = 0;
        }
    }

    // Map Tapis job status to NodeODM-like info
    updateInfoFromJobStatus(tapisStatus){
        switch (tapisStatus) {
            case 'PENDING':
            case 'PROCESSING_INPUTS':
            case 'STAGING_INPUTS':
            case 'STAGING_JOB':
            case 'SUBMITTING_JOB':
            case 'QUEUED':
                this.nodeData.info.taskQueueCount = 1;
                break;
            case 'RUNNING':
                this.nodeData.info.taskQueueCount = 1;
                break;
            case 'ARCHIVING':
                this.nodeData.info.taskQueueCount = 1;
                break;
            case 'FINISHED':
            case 'CANCELLED':
            case 'FAILED':
                this.nodeData.info.taskQueueCount = 0;
                break;
            default:
                this.nodeData.info.taskQueueCount = 0;
        }
    }

    // Submit job to Tapis queue (without data initially)
    async submitJobToQueue(imagesCount, taskOptions){
        if (this.jobSubmitted) {
            throw new Error('Job already submitted for this node');
        }

        try {
            logger.info(`[TAPIS DEBUG] Submitting Tapis job to queue for ${imagesCount} images (no input files yet)`);

            // Submit the Tapis job without input files - this starts the NodeODM instance
            this.tapisJobId = await this.tapisProvider.submitJobWithoutData(
                this.tapisToken,
                this.jobId,
                imagesCount,
                taskOptions
            );

            this.jobSubmitted = true;
            logger.info(`Submitted Tapis job ${this.tapisJobId} for node ${this.jobId} - waiting for NodeODM to come online`);

            return this.tapisJobId;
        } catch (e) {
            logger.error(`Failed to submit job for node ${this.jobId}: ${e.message}`);
            throw e;
        }
    }

    // Submit job with data upload - called by taskNew
    async submitJob(imagesCount, taskOptions, fileNames, tmpPath){
        try {
            logger.info(`[TAPIS DEBUG] Starting submitJob for ${imagesCount} images`);

            // Check if job was already submitted during node creation
            if (!this.jobSubmitted || !this.tapisJobId) {
                logger.info(`[TAPIS DEBUG] Job not yet submitted, submitting to queue first`);
                await this.submitJobToQueue(imagesCount, taskOptions);
            } else {
                logger.info(`[TAPIS DEBUG] Job already submitted (${this.tapisJobId}), proceeding with file upload`);
            }

            // Upload the files to the existing job
            logger.info(`[TAPIS DEBUG] Uploading ${fileNames.length} files to job ${this.tapisJobId}`);
            await this.tapisProvider.uploadFiles(
                this.tapisToken,
                fileNames,
                tmpPath,
                this.jobId
            );

            logger.info(`[TAPIS DEBUG] Successfully completed submitJob for job ${this.tapisJobId}`);
            return this.tapisJobId;
        } catch (e) {
            logger.error(`[TAPIS DEBUG] submitJob failed: ${e.message}`);
            throw e;
        }
    }

    // Store task data to be sent when node comes online
    setPendingTaskData(imagesCount, taskOptions, fileNames, tmpPath){
        this.pendingTaskData = {
            imagesCount,
            taskOptions,
            fileNames,
            tmpPath,
            taskId: require('crypto').randomUUID()
        };
        logger.info(`[TAPIS DEBUG] Stored pending task data for node ${this.jobId}, taskId: ${this.pendingTaskData.taskId}`);
    }

    // Called when the actual NodeODM registers with ClusterODM
    async onNodeRegistered(nodeHostname, nodePort, nodeToken){
        logger.info(`[TAPIS DEBUG] Node registered: ${nodeHostname}:${nodePort} for job ${this.jobId}`);
        this.nodeRegistered = true;
        this.hostname = nodeHostname;
        this.port = nodePort;
        this.token = nodeToken;

        // If we have pending task data, send it to the node now
        if (this.pendingTaskData) {
            await this.sendPendingTaskToNode();
        }
    }

    // Send the pending photos to the registered node
    async sendPendingTaskToNode(){
        if (!this.pendingTaskData || !this.nodeRegistered) {
            return;
        }

        try {
            logger.info(`[TAPIS DEBUG] Sending photos to registered NodeODM ${this.hostname}:${this.port}`);

            const { taskOptions, fileNames, tmpPath } = this.pendingTaskData;

            // Create a NodeODM task directly on the registered node with the photos
            const axios = require('axios');
            const FormData = require('form-data');
            const fs = require('fs');
            const path = require('path');

            const form = new FormData();
            form.append('name', `tapis_job_${this.jobId}`);

            // Add processing options
            for (const [key, value] of Object.entries(taskOptions)) {
                form.append(key, value);
            }

            // Add image files to the form
            for (const fileName of fileNames) {
                const filePath = path.join(tmpPath, fileName);
                if (fs.existsSync(filePath)) {
                    form.append('images', fs.createReadStream(filePath));
                }
            }

            const nodeUrl = `http://${this.hostname}:${this.port}`;
            const tokenParam = this.token ? `?token=${this.token}` : '';

            logger.info(`[TAPIS DEBUG] Posting task with ${fileNames.length} images to ${nodeUrl}/task/new`);

            const response = await axios.post(`${nodeUrl}/task/new${tokenParam}`, form, {
                headers: {
                    ...form.getHeaders()
                },
                timeout: 300000 // 5 minutes
            });

            this.currentTask = response.data.uuid;
            logger.info(`[TAPIS DEBUG] Successfully created task ${this.currentTask} on registered NodeODM`);

            // Clear pending data and clean up temp files
            this.pendingTaskData = null;
            try {
                const utils = require('../utils');
                utils.rmdir(tmpPath);
                logger.info(`[TAPIS DEBUG] Cleaned up tmp directory: ${tmpPath}`);
            } catch (e) {
                logger.warn(`Could not clean up tmp directory: ${e.message}`);
            }

            return response.data;
        } catch (e) {
            logger.error(`Failed to send photos to registered NodeODM: ${e.message}`);
            throw e;
        }
    }

    // Override task methods to work with Tapis jobs
    async taskInfo(taskId){
        try {
            if (!this.tapisJobId) {
                return {
                    uuid: taskId,
                    name: `Tapis Job ${this.jobId}`,
                    dateCreated: new Date().getTime(),
                    status: { code: statusCodes.RUNNING },
                    processingTime: 0
                };
            }

            const status = await this.tapisProvider.getJobStatus(this.tapisToken, this.tapisJobId);
            const nodeStatus = this.mapTapisStatusToNodeODM(status);
            
            return {
                uuid: taskId,
                name: `Tapis Job ${this.jobId}`,
                dateCreated: new Date().getTime(),
                status: { code: nodeStatus },
                processingTime: 0,
                tapisJobId: this.tapisJobId,
                tapisStatus: status
            };
        } catch (e) {
            return { error: e.message };
        }
    }

    async taskOutput(taskId, line = 0){
        try {
            if (!this.tapisJobId) {
                return [`Preparing job submission...`];
            }

            const status = await this.tapisProvider.getJobStatus(this.tapisToken, this.tapisJobId);
            const output = [`Tapis Job Status: ${status}`];
            
            switch (status) {
                case 'PENDING':
                    output.push('Job is pending in the queue...');
                    break;
                case 'PROCESSING_INPUTS':
                    output.push('Processing input files...');
                    break;
                case 'STAGING_INPUTS':
                    output.push('Staging input files to compute system...');
                    break;
                case 'STAGING_JOB':
                    output.push('Staging job to compute system...');
                    break;
                case 'SUBMITTING_JOB':
                    output.push('Submitting job to scheduler...');
                    break;
                case 'QUEUED':
                    output.push('Job is queued on the compute system...');
                    break;
                case 'RUNNING':
                    output.push('Job is running on the compute system...');
                    output.push('Processing ODM workflow...');
                    break;
                case 'ARCHIVING':
                    output.push('Job completed, archiving results...');
                    break;
                case 'FINISHED':
                    output.push('Job completed successfully!');
                    output.push('Results are available for download.');
                    break;
                case 'CANCELLED':
                    output.push('Job was cancelled.');
                    break;
                case 'FAILED':
                    output.push('Job failed to complete.');
                    break;
                default:
                    output.push(`Unknown status: ${status}`);
            }

            return output;
        } catch (e) {
            return [`Error getting job output: ${e.message}`];
        }
    }

    async taskCancel(taskId){
        try {
            if (this.tapisJobId) {
                await this.tapisProvider.cancelJob(this.tapisToken, this.tapisJobId);
                return { success: true };
            } else {
                return { error: 'No job to cancel' };
            }
        } catch (e) {
            return { error: e.message };
        }
    }

    async taskRemove(taskId){
        // For Tapis jobs, removing is the same as cancelling
        return await this.taskCancel(taskId);
    }

    // Cancel the Tapis job
    async cancelJob(){
        if (this.tapisJobId) {
            await this.tapisProvider.cancelJob(this.tapisToken, this.tapisJobId);
        }
    }

    // Map Tapis job status to NodeODM status codes
    mapTapisStatusToNodeODM(tapisStatus){
        switch (tapisStatus) {
            case 'PENDING':
            case 'PROCESSING_INPUTS':
            case 'STAGING_INPUTS':
            case 'STAGING_JOB':
            case 'SUBMITTING_JOB':
            case 'QUEUED':
            case 'RUNNING':
            case 'ARCHIVING':
                return statusCodes.RUNNING;
            case 'FINISHED':
                return statusCodes.COMPLETED;
            case 'CANCELLED':
                return statusCodes.CANCELED;
            case 'FAILED':
                return statusCodes.FAILED;
            default:
                return statusCodes.QUEUED;
        }
    }

    // Override proxy methods since we don't have direct HTTP access
    proxyTargetUrl(){
        // If waiting for registration, return null to prevent routing
        if (this.waitingForRegistration) {
            return null;
        }

        // If real NodeODM is registered, use its URL
        if (this.nodeRegistered && this.hostname && this.port) {
            return `http://${this.hostname}:${this.port}`;
        }

        // Fallback for older virtual nodes
        return `http://tapis-job-${this.jobId}:3000`;
    }

    // Override URL generation for Tapis-specific endpoints
    urlFor(pathname, query = {}){
        // For Tapis nodes, we don't use direct URLs
        // This is mainly for compatibility
        return `http://tapis-job-${this.jobId}:3000${pathname}`;
    }

    // Check if job is ready for task assignment
    isReadyForTask(){
        // If waiting for registration, not ready yet
        if (this.waitingForRegistration) {
            return false;
        }

        return !this.jobSubmitted && this.currentTask === null;
    }

    // Set current task
    setCurrentTask(taskId){
        this.currentTask = taskId;
    }

    // Get current task
    getCurrentTask(){
        return this.currentTask;
    }

    // Override toString for better identification
    toString(){
        return `TapisJob:${this.jobId}`;
    }

    // Override availableSlots to handle job-specific logic
    availableSlots(){
        // If waiting for registration, no slots available
        if (this.waitingForRegistration) {
            return 0;
        }

        // If real NodeODM is registered, check its capacity
        if (this.nodeRegistered && this.hostname && this.port) {
            return this.nodeData.info.maxParallelTasks - this.nodeData.info.taskQueueCount;
        }

        // Legacy behavior for older virtual nodes
        if (!this.jobSubmitted || this.currentTask === null) {
            return 1;
        }
        return 0;
    }

    // Check if the Tapis job has completed
    async isJobCompleted(){
        if (!this.tapisJobId) return false;
        
        const status = await this.tapisProvider.getJobStatus(this.tapisToken, this.tapisJobId);
        return ['FINISHED', 'CANCELLED', 'FAILED'].includes(status);
    }

    // Override getOptions to return mock options without HTTP call
    async getOptions(){
        return [
            {name: 'dsm', type: 'bool', value: false, domain: [true, false], help: 'Use a digital surface model for orthophoto generation'},
            {name: 'orthophoto-resolution', type: 'float', value: 5, domain: 'float', help: 'Orthophoto resolution in cm/px'},
            {name: 'dem-resolution', type: 'float', value: 5, domain: 'float', help: 'DEM resolution in cm/px'},
            {name: 'pc-quality', type: 'enum', value: 'medium', domain: ['ultra', 'high', 'medium', 'low', 'lowest'], help: 'Point cloud quality'},
            {name: 'feature-quality', type: 'enum', value: 'high', domain: ['ultra', 'high', 'medium', 'low', 'lowest'], help: 'Feature extraction quality'}
        ];
    }

    // Override task creation methods to handle internally
    async taskNew(options, files, progress, finished, error){
        try {
            // Set current task
            const taskId = require('crypto').randomUUID();
            this.setCurrentTask(taskId);
            
            // Submit the Tapis job
            const fileNames = files.map(f => f.originalname || f.name);
            const tmpPath = files[0].path ? require('path').dirname(files[0].path) : '/tmp';
            
            await this.submitJob(files.length, options, fileNames, tmpPath);
            
            // Return task info
            if (finished) finished(null, {uuid: taskId});
            
            return {uuid: taskId};
        } catch (e) {
            if (error) error(e);
            throw e;
        }
    }

    // Override taskDownload for result retrieval
    async taskDownload(taskId, asset){
        try {
            if (asset === 'all.zip') {
                // Download all results as zip
                const outputPath = '/tmp/tapis-output';
                await this.tapisProvider.downloadJobResults(
                    this.tapisToken, 
                    this.jobId, 
                    this.tapisJobId, 
                    outputPath
                );
                return outputPath;
            }
            throw new Error(`Asset ${asset} not supported`);
        } catch (e) {
            throw new Error(`Cannot download ${asset}: ${e.message}`);
        }
    }
};