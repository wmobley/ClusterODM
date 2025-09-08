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
            if (this.tapisJobId) {
                const status = await this.tapisProvider.getJobStatus(this.tapisToken, this.tapisJobId);
                this.updateInfoFromJobStatus(status);
            } else if (this.currentTask) {
                // Job not yet submitted, show as busy
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

    // Submit job when task is assigned
    async submitJob(imagesCount, taskOptions, fileNames, tmpPath){
        if (this.jobSubmitted) {
            throw new Error('Job already submitted for this node');
        }

        try {
            logger.info(`[TAPIS DEBUG] submitJob called with tmpPath: ${tmpPath}, fileNames: ${fileNames}`);
            
            // Debug: Check what's in tmpPath right at the start of submitJob
            try {
                const fs = require('fs');
                const filesAtStart = fs.readdirSync(tmpPath);
                logger.info(`[TAPIS DEBUG] Files in tmpPath at start of submitJob: ${filesAtStart.join(', ')}`);
            } catch (e) {
                logger.error(`[TAPIS DEBUG] Cannot read tmpPath at start: ${e.message}`);
            }
            
            // Upload files to Tapis storage
            this.inputPath = await this.tapisProvider.uploadFiles(
                this.tapisToken, 
                fileNames, 
                tmpPath, 
                this.jobId
            );
            
            logger.info(`[TAPIS DEBUG] uploadFiles completed successfully`);

            // Submit the Tapis job
            this.tapisJobId = await this.tapisProvider.submitJob(
                this.tapisToken,
                this.jobId,
                this.inputPath,
                imagesCount,
                taskOptions
            );

            this.jobSubmitted = true;
            logger.info(`Submitted Tapis job ${this.tapisJobId} for node ${this.jobId}`);
            
            return this.tapisJobId;
        } catch (e) {
            logger.error(`Failed to submit job for node ${this.jobId}: ${e.message}`);
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
        // Return a dummy URL since Tapis jobs don't have direct HTTP endpoints
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
        if (!this.jobSubmitted || this.currentTask === null) {
            return 1; // Can accept one task
        }
        return 0; // Already processing a task
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