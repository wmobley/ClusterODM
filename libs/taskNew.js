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
const Busboy = require('busboy');
const utils = require('./utils');
const netutils = require('./netutils');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const Curl = require('node-libcurl').Curl;
const tasktable = require('./tasktable');
const routetable = require('./routetable');
const nodes = require('./nodes');
const odmOptions = require('./odmOptions');
const statusCodes = require('./statusCodes');
const asrProvider = require('./asrProvider');
const logger = require('./logger');
const events = require('events');

const assureUniqueFilename = (dstPath, filename) => {
    return new Promise((resolve, _) => {
        const dstFile = path.join(dstPath, filename);
        fs.exists(dstFile, async exists => {
            if (!exists) resolve(filename);
            else{
                const parts = filename.split(".");
                if (parts.length > 1){
                    resolve(await assureUniqueFilename(dstPath, 
                        `${parts.slice(0, parts.length - 1).join(".")}_.${parts[parts.length - 1]}`));
                }else{
                    // Filename without extension? Strange..
                    resolve(await assureUniqueFilename(dstPath, filename + "_"));
                }
            }
        });
    });
};

const getUuid = async (req) => {
    if (req.headers['set-uuid']){
        const userUuid = req.headers['set-uuid'];
        
        // Valid UUID and no other task with same UUID?
        console.log(userUuid);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userUuid)){
            if (await tasktable.lookup(userUuid)){
                throw new Error(`Invalid set-uuid: ${userUuid}`);
            }else if (await routetable.lookup(userUuid)){
                throw new Error(`Invalid set-uuid: ${userUuid}`);
            }else{
                return userUuid;
            }
        }else{
            throw new Error(`Invalid set-uuid: ${userUuid}`);
        }
    }

    return utils.uuidv4();
};

module.exports = {
    // @return {object} Context object with methods and variables to use during task/new operations 
    createContext: async function(req, res){
        let uuid = await getUuid(req);

        const tmpPath = path.join('tmp', uuid);

        if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath);

        // Track if response has been sent to prevent double responses
        let responseSent = false;
        
        return {
            uuid, 
            tmpPath,
            die: (err) => {
                if (responseSent) {
                    logger.warn(`[TAPIS DEBUG] Attempted to send response after already sent: ${err}`);
                    return;
                }
                responseSent = true;
                utils.rmdir(tmpPath);
                utils.json(res, {error: err});
                asrProvider.cleanup(uuid);
            },
            markResponseSent: () => {
                responseSent = true;
            },
            isResponseSent: () => responseSent
        };
    },

    formDataParser: function(req, onFinish, options = {}){
        logger.info(`[TAPIS DEBUG] formDataParser called with ${arguments.length} arguments`);
        logger.info(`[TAPIS DEBUG] formDataParser arg[2] (options): ${JSON.stringify(arguments[2])}`);
        
        // TEMPORARY HACK: Force saveFilesToDir for Tapis debugging
        if (req.url && req.url.includes('/task/new/init')) {
            options = arguments[2] || {};
            if (!options.saveFilesToDir) {
                logger.info(`[TAPIS DEBUG] HACK: Forcing saveFilesToDir for /task/new/init`);
                options.saveFilesToDir = "tmp/" + Math.random().toString(36).substr(2, 9);
                const fs = require('fs');
                if (!fs.existsSync(options.saveFilesToDir)) {
                    fs.mkdirSync(options.saveFilesToDir, { recursive: true });
                }
                // Store the temp dir for later use
                global.lastTempDir = options.saveFilesToDir;
            }
        }
        
        if (options.saveFilesToDir === undefined) options.saveFilesToDir = false;
        if (options.parseFields === undefined) options.parseFields = true;
        if (options.limits === undefined) options.limits = {};
        
        logger.info(`[TAPIS DEBUG] formDataParser processed options: saveFilesToDir=${options.saveFilesToDir}, parseFields=${options.parseFields}`);
        
        // If parseFields is false, don't use Busboy - this is for processing existing files
        if (!options.parseFields) {
            logger.info(`[TAPIS DEBUG] parseFields=false, processing existing files instead of parsing form`);
            
            const params = {
                options: null,
                taskName: "",
                skipPostProcessing: false,
                outputs: null,
                dateCreated: null,
                error: null,
                webhook: "",
                fileNames: [],
                imagesCount: 0
            };
            
            // Read existing files from saveFilesToDir
            const fs = require('fs');
            const path = require('path');
            
            if (options.saveFilesToDir && fs.existsSync(options.saveFilesToDir)) {
                const allFiles = fs.readdirSync(options.saveFilesToDir);
                logger.info(`[TAPIS DEBUG] All files in directory: ${JSON.stringify(allFiles)}`);
                
                const files = allFiles.filter(f => {
                    const isImage = f.toLowerCase().endsWith('.jpg') || 
                                   f.toLowerCase().endsWith('.jpeg') ||
                                   f.toLowerCase().endsWith('.png') ||
                                   f.toLowerCase().endsWith('.tiff');
                    logger.info(`[TAPIS DEBUG] File ${f}: isImage=${isImage}`);
                    return isImage;
                });
                
                params.fileNames = files;
                params.imagesCount = files.length;
                logger.info(`[TAPIS DEBUG] Found ${files.length} image files: ${JSON.stringify(files)}`);
            }
            
            // Read body.json if it exists
            const bodyPath = path.join(options.saveFilesToDir, 'body.json');
            if (fs.existsSync(bodyPath)) {
                try {
                    const bodyData = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
                    Object.assign(params, bodyData);
                    logger.info(`[TAPIS DEBUG] Loaded body.json: ${bodyData.taskName}`);
                } catch (e) {
                    logger.error(`[TAPIS DEBUG] Failed to read body.json: ${e.message}`);
                }
            }
            
            // Call the callback immediately
            onFinish(params);
            return;
        }
        
        const busboy = new Busboy({ headers: req.headers });

        const params = {
            options: null,
            taskName: "",
            skipPostProcessing: false,
            outputs: null,
            dateCreated: null,
            error: null,
            webhook: "",
            fileNames: [],
            imagesCount: 0
        };
        
        // Track completion state for manual busboy finish detection
        let expectedFiles = 0;
        let completedFiles = 0;
        let requestEnded = false;
        let formFinished = false;
        
        const checkCompletion = () => {
            logger.info(`[TAPIS DEBUG] Completion check: expectedFiles=${expectedFiles}, completedFiles=${completedFiles}, requestEnded=${requestEnded}, formFinished=${formFinished}`);
            if (expectedFiles > 0 && completedFiles >= expectedFiles && requestEnded && !formFinished) {
                // Check if a response was already sent via error handling
                if (params && params.isResponseSent && params.isResponseSent()) {
                    logger.info(`[TAPIS DEBUG] Response already sent, skipping onFinish`);
                    return;
                }
                logger.info(`[TAPIS DEBUG] Manual completion detected - calling onFinish`);
                formFinished = true;
                onFinish(params);
            }
        };

        if (options.parseFields){
            busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                logger.info(`[TAPIS DEBUG] Form field received: ${fieldname} = ${val}`);
                // Save options
                if (fieldname === 'options'){
                    params.options = val;
                }
    
                else if (fieldname === 'zipurl' && val){
                    params.error = "File upload via URL is not available. Sorry :(";
                }
    
                else if (fieldname === 'name' && val){
                    params.taskName = val;
                }
    
                else if (fieldname === 'skipPostProcessing' && val === 'true'){
                    params.skipPostProcessing = val;
                }

                else if (fieldname === 'outputs' && val){
                    params.outputs = val;
                }

                else if (fieldname === 'dateCreated' && !isNaN(parseInt(val))){
                    params.dateCreated = parseInt(val);
                }

                else if (fieldname === 'webhook' && val){
                    params.webhook = val;
                }
            });
        }
        if (options.saveFilesToDir){
            logger.info(`[TAPIS DEBUG] Setting up file handler for saveFilesToDir: ${options.saveFilesToDir}`);
            busboy.on('file', async function(fieldname, file, filename, encoding, mimetype) {
                logger.info(`[TAPIS DEBUG] File upload received: fieldname=${fieldname}, filename=${filename}`);
                if (fieldname === 'images'){
                    expectedFiles++;
                    logger.info(`[TAPIS DEBUG] Expected files count: ${expectedFiles}`);
                    if (options.limits.maxImages && params.imagesCount > options.limits.maxImages){
                        params.error = "Max images count exceeded.";
                        file.resume();
                        return;
                    }
                    
                    filename = utils.sanitize(filename);
                    
                    // Special case
                    if (filename === 'body.json') filename = '_body.json';

                    filename = await assureUniqueFilename(options.saveFilesToDir, filename);

                    const name = path.basename(filename);
                    params.fileNames.push(name);
                    logger.info(`[TAPIS DEBUG] Added filename to array: ${name}, fileNames length: ${params.fileNames.length}`);
        
                    const saveTo = path.join(options.saveFilesToDir, name);
                    let saveStream = null;

                    // Track whether the file upload completed successfully and cleanup status
                    let uploadCompleted = false;
                    let cleanupHandled = false;
                    const handlerId = Math.random().toString(36).substr(2, 9);
                    logger.info(`[TAPIS DEBUG] Created handleClose handler ${handlerId} for ${saveTo}`);
                    
                    // Detect if a connection is aborted/interrupted
                    // and cleanup any open streams to avoid fd leaks
                    const handleClose = () => {
                        const stack = new Error().stack;
                        logger.info(`[TAPIS DEBUG] handleClose ${handlerId} triggered for ${saveTo}, uploadCompleted: ${uploadCompleted}, cleanupHandled: ${cleanupHandled}`);
                        logger.info(`[TAPIS DEBUG] handleClose ${handlerId} called from: ${stack.split('\n').slice(1,4).join('\n')}`);
                        
                        // Prevent multiple cleanup attempts
                        if (cleanupHandled) {
                            logger.info(`[TAPIS DEBUG] Cleanup already handled for ${saveTo}, skipping`);
                            return;
                        }
                        cleanupHandled = true;
                        
                        if (saveStream){
                            saveStream.close();
                            saveStream = null;
                        }
                        
                        // Check conditions synchronously before any async operations
                        const tmpDir = path.dirname(saveTo);
                        const shouldDelete = !uploadCompleted && !global.taskProcessingDirs?.has(tmpDir);
                        
                        if (shouldDelete) {
                            // Double-check the conditions right before deletion (race condition protection)
                            fs.exists(saveTo, exists => {
                                if (exists) {
                                    // Final check before actual deletion to prevent race condition
                                    if (!global.taskProcessingDirs?.has(tmpDir)) {
                                        logger.info(`[TAPIS DEBUG] DELETING incomplete file: ${saveTo}`);
                                        fs.unlink(saveTo, err => {
                                            if (err) logger.error(err);
                                            else logger.info(`[TAPIS DEBUG] Successfully deleted incomplete file: ${saveTo}`);
                                        });
                                    } else {
                                        logger.info(`[TAPIS DEBUG] NOT deleting ${saveTo} - task processing started during cleanup`);
                                    }
                                }
                            });
                        } else {
                            if (uploadCompleted) {
                                logger.info(`[TAPIS DEBUG] NOT deleting ${saveTo} - upload completed successfully`);
                            } else {
                                logger.info(`[TAPIS DEBUG] NOT deleting ${saveTo} - task processing in progress`);
                            }
                        }
                    };
                    req.on('close', handleClose);
                    req.on('abort', handleClose);

                    saveStream = fs.createWriteStream(saveTo);
                    
                    saveStream.on('error', (err) => {
                        logger.error(`[TAPIS DEBUG] Write stream error for ${filename}: ${err.message}`);
                        params.error = `File upload error: ${err.message}`;
                    });
                    
                    // Handle the file stream end event for busboy completion
                    file.on('end', () => {
                        logger.info(`[TAPIS DEBUG] File stream 'end' event for ${filename}`);
                        req.removeListener('close', handleClose);
                        req.removeListener('abort', handleClose);
                        // Don't increment here - wait for write stream to finish
                    });
                    
                    file.on('error', (err) => {
                        logger.error(`[TAPIS DEBUG] File stream error for ${filename}: ${err.message}`);
                        params.error = `File upload error: ${err.message}`;
                    });
                    
                    // Monitor writeStream finish - this is when file is actually saved
                    saveStream.on('finish', () => {
                        logger.info(`[TAPIS DEBUG] Write stream finished for ${filename}`);
                        
                        // Verify file was actually written
                        if (fs.existsSync(saveTo)) {
                            const stats = fs.statSync(saveTo);
                            logger.info(`[TAPIS DEBUG] File confirmed on disk: ${filename} (${stats.size} bytes)`);
                            
                            // Mark upload as completed successfully to prevent deletion
                            uploadCompleted = true;
                            cleanupHandled = true; // Prevent any cleanup for this file
                            
                            // Remove close/abort listeners since upload completed successfully
                            req.removeListener('close', handleClose);
                            req.removeListener('abort', handleClose);
                            logger.info(`[TAPIS DEBUG] Removed event listeners for successful upload: ${filename}`);
                            
                            // Now it's safe to count this file as completed
                            params.imagesCount++;
                            logger.info(`[TAPIS DEBUG] File saved: ${filename}, total images: ${params.imagesCount}`);
                            
                            if (options.limits.maxImages && params.imagesCount > options.limits.maxImages){
                                params.error = "Max images count exceeded.";
                            }
                        } else {
                            logger.error(`[TAPIS DEBUG] File not found on disk after finish: ${filename}`);
                            params.error = `File upload failed: ${filename}`;
                        }
                        
                        saveStream = null;
                        completedFiles++;
                        logger.info(`[TAPIS DEBUG] Completed files count: ${completedFiles}`);
                        checkCompletion();
                    });
                    
                    file.pipe(saveStream);
                }
            });
        }
        busboy.on('finish', function(){
            logger.info(`[TAPIS DEBUG] Form parsing finished. imagesCount: ${params.imagesCount}`);
            logger.info(`[TAPIS DEBUG] Calling onFinish callback with params`);
            onFinish(params);
        });
        
        busboy.on('error', function(err){
            logger.error(`[TAPIS DEBUG] Busboy error: ${err.message}`);
            params.error = err.message;
            onFinish(params);
        });
        
        // Add more debugging for busboy events
        busboy.on('fieldsLimit', () => {
            logger.warn(`[TAPIS DEBUG] Busboy fieldsLimit reached`);
        });
        
        busboy.on('filesLimit', () => {
            logger.warn(`[TAPIS DEBUG] Busboy filesLimit reached`);
        });
        
        busboy.on('partsLimit', () => {
            logger.warn(`[TAPIS DEBUG] Busboy partsLimit reached`);
        });
        
        // Debug the request stream
        req.on('end', () => {
            logger.info(`[TAPIS DEBUG] Request stream ended`);
            requestEnded = true;
            checkCompletion();
        });
        
        req.on('close', () => {
            logger.info(`[TAPIS DEBUG] Request stream closed`);
        });
        
        req.on('error', (err) => {
            logger.error(`[TAPIS DEBUG] Request stream error: ${err.message}`);
        });
        
        logger.info(`[TAPIS DEBUG] About to pipe request to busboy`);
        req.pipe(busboy);
    },

    getTaskIdFromPath: function(pathname){
        const matches = pathname.match(/\/([\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+)$/);

        if (matches && matches[1]){
            return matches[1];        
        }else return null;
    },

    augmentTaskOptions: function(req, taskOptions, limits, token){
        if (typeof taskOptions === "string") taskOptions = JSON.parse(taskOptions);
        if (!Array.isArray(taskOptions)) taskOptions = [];
        let odmOptions = [];

        if (config.splitmerge){
            // We automatically set the "sm-cluster" parameter
            // to match the address that was used to reach ClusterODM.
            // if "--split" is set.
            const clusterUrl = netutils.publicAddressPath('/', req, token);

            let foundSplit = false, foundSMCluster = false;
            taskOptions.forEach(to => {
                if (to.name === 'split'){
                    foundSplit = true;
                    odmOptions.push({name: to.name, value: to.value});
                }else if (to.name === 'sm-cluster'){
                    foundSMCluster = true;
                    odmOptions.push({name: to.name, value: clusterUrl});
                }else{
                    odmOptions.push({name: to.name, value: to.value});
                }
            });

            if (foundSplit && !foundSMCluster){
                odmOptions.push({name: 'sm-cluster', value: clusterUrl });
            }
        }else{
            // Make sure the "sm-cluster" parameter is removed
            odmOptions = utils.clone(taskOptions.filter(to => to.name !== 'sm-cluster'));
        }

        // Check limits
        if (limits.options){
            const limitOptions = limits.options;
            const assureOptions = {};

            for (let name in limitOptions){
                let lo = limitOptions[name];
                if (lo.assure && lo.value !== undefined) assureOptions[name] = {name, value: lo.value};
            }

            for (let i in odmOptions){
                let odmOption = odmOptions[i];

                if (limitOptions[odmOption.name] !== undefined){
                    let lo = limitOptions[odmOption.name];

                    if (assureOptions[odmOption.name]) delete(assureOptions[odmOption.name]);
        
                    // Modify value if between range rules command so
                    if (lo.between !== undefined){
                        if (lo.between.max_if_equal_to !== undefined && lo.between.max !== undefined &&
                            odmOption.value == lo.between.max_if_equal_to){
                            odmOption.value = lo.between.max;
                        }
                        if (lo.between.max !== undefined && lo.between.min !== undefined){
                            odmOption.value = Math.max(lo.between.min, Math.min(lo.between.max, odmOption.value));
                        }
                    }

                    // Handle booleans
                    if (lo.value === 'true'){
                        odmOption.value = true;
                    }
                }
            }

            for (let i in assureOptions){
                odmOptions.push(assureOptions[i]);
            }
        }

        return odmOptions;
    },

    process: async function(req, res, cloudProvider, uuid, params, token, limits, getLimitedOptions){
        const tmpPath = path.join("tmp", uuid);
        let { options, taskName, skipPostProcessing, outputs, dateCreated, fileNames, imagesCount, webhook } = params;
        
        // Initialize global directory tracking if not exists
        if (!global.taskProcessingDirs) {
            global.taskProcessingDirs = new Set();
        }
        
        // Mark this directory as being processed to prevent file cleanup
        global.taskProcessingDirs.add(tmpPath);
        logger.info(`[TAPIS DEBUG] Marked directory ${tmpPath} as processing, total processing dirs: ${global.taskProcessingDirs.size}`);
        
        // Fix imagesCount - use actual fileNames array length instead of the potentially incorrect counter
        if (fileNames && Array.isArray(fileNames)) {
            imagesCount = fileNames.length;
            logger.info(`[TAPIS DEBUG] Fixed imagesCount from ${params.imagesCount} to ${imagesCount} based on fileNames array`);
        }

        logger.info(`[TAPIS DEBUG] Starting task processing for UUID: ${uuid}`);
        
        // Debug: Check if files still exist at the very start of task processing
        try {
            const fs = require('fs');
            const filesAtProcessStart = fs.readdirSync(tmpPath);
            logger.info(`[TAPIS DEBUG] Files in tmpPath at START of task processing: ${filesAtProcessStart.join(', ')}`);
        } catch (e) {
            logger.error(`[TAPIS DEBUG] Cannot read tmpPath at START of task processing: ${e.message}`);
        }
        
        logger.info(`[TAPIS DEBUG] fileNames: ${JSON.stringify(fileNames)}, imagesCount: ${imagesCount}`);
        logger.info(`[TAPIS DEBUG] taskName: ${taskName}, token: ${token ? 'present' : 'missing'}`);

        if (fileNames.length < 1){
            logger.error(`[TAPIS DEBUG] ERROR: Not enough images (${fileNames.length} files uploaded)`);
            throw new Error(`Not enough images (${fileNames.length} files uploaded)`);
        }

        // When --no-splitmerge is set, do not allow seed.zip
        if (!config.splitmerge){
            if (fileNames.indexOf("seed.zip") !== -1) throw new Error("Cannot use this node as a split-merge cluster.");
        }

        // Check with provider if we're allowed to process these many images
        // at this resolution
        const { approved, error } = await cloudProvider.approveNewTask(token, imagesCount);
        if (!approved) throw new Error(error);

        let node = await nodes.findBestAvailableNode(imagesCount, true);

        // Do we need to / can we create a new node via autoscaling?
        const autoscale = (!node || node.availableSlots() === 0) && 
                            asrProvider.isAllowedToCreateNewNodes() &&
                            asrProvider.canHandle(fileNames.length);
        
        logger.info(`[TAPIS DEBUG] Autoscale decision: ${autoscale}, node: ${node ? 'exists' : 'null'}`);
        logger.info(`[TAPIS DEBUG] ASR canCreateNodes: ${asrProvider.isAllowedToCreateNewNodes()}, canHandle: ${asrProvider.canHandle(fileNames.length)}`);
        
        // TEMPORARY: Log the autoscale path that would be taken
        if (autoscale) {
            logger.info(`[TAPIS DEBUG] WOULD PROCEED TO AUTOSCALE NODE CREATION`);
            logger.info(`[TAPIS DEBUG] Would call asr.createNode() at line 648+`);
        }

        if (autoscale) {
            node = nodes.referenceNode(); // Use the reference node for task options purposes
            logger.info(`[TAPIS DEBUG] referenceNode result: ${node ? node.constructor.name : 'null'}`);
            
            // If no reference node exists, create a basic one for validation purposes
            if (!node) {
                logger.info(`[TAPIS DEBUG] No reference node found, creating basic node for autoscale validation`);
                const Node = require('./classes/Node');
                node = new Node('localhost', 3000); // Create a dummy node for validation
                node.nodeData.info = { version: '1.0.0', taskQueueCount: 0 }; // Set basic info
            }
        }

        if (node){
            // Validate options
            // Will throw an exception on failure
            let taskOptions = odmOptions.filterOptions(this.augmentTaskOptions(req, options, limits, token), 
                                                        await getLimitedOptions(token, limits, node));

            const dateC = dateCreated !== null ? new Date(dateCreated) : new Date();
            const name = taskName || "Task of " + (dateC).toISOString();

            const taskInfo = {
                uuid,
                name,
                dateCreated: dateC.getTime(),
                // processingTime: <auto update>,
                status: {code: statusCodes.RUNNING},
                options: taskOptions,
                imagesCount: imagesCount
            };

            const PARALLEL_UPLOADS = 20;

            const eventEmitter = new events.EventEmitter();
            eventEmitter.setMaxListeners(2 * (2 + PARALLEL_UPLOADS + 1));

            const curlInstance = (done, onError, url, body, validate) => {
                // We use CURL, because NodeJS libraries are buggy
                const curl = new Curl(),
                      close = curl.close.bind(curl);
                
                const tryClose = () => {
                    try{
                        close();
                    }catch(e){
                        logger.warn(`Cannot close cURL: ${e.message}`);
                    }
                    eventEmitter.removeListener('abort', tryClose);
                    eventEmitter.removeListener('close', tryClose);
                };

                eventEmitter.on('abort', tryClose);
                eventEmitter.on('close', tryClose);

                curl.on('end', async (statusCode, body, headers) => {
                    try{
                        if (statusCode === 200){
                            body = JSON.parse(body);
                            if (body.error) throw new Error(body.error);
                            if (validate !== undefined) validate(body);

                            done();
                        }else{
                            throw new Error(`POST ${url} statusCode is ${statusCode}, expected 200`);
                        }
                    }catch(e){
                        onError(e);
                    }
                });

                curl.on('error', onError);

                // logger.info(`Curl URL: ${url}`);
                // logger.info(`Curl Body: ${JSON.stringify(body)}`);

                curl.setOpt(Curl.option.URL, url);
                curl.setOpt(Curl.option.HTTPPOST, body || []);
                if (config.upload_max_speed) curl.setOpt(Curl.option.MAX_SEND_SPEED_LARGE, config.upload_max_speed);
                // abort if slower than 30 bytes/sec during 1600 seconds */
                curl.setOpt(Curl.option.LOW_SPEED_TIME, 1600);
                curl.setOpt(Curl.option.LOW_SPEED_LIMIT, 30);
                curl.setOpt(Curl.option.HTTPHEADER, [
                    'Content-Type: multipart/form-data'
                ]);

                return curl;
            };

            const taskNewInit = async () => {
                return new Promise((resolve, reject) => {
                    const body = [];
                    body.push({
                        name: 'name',
                        contents: name
                    });
                    body.push({
                        name: 'options',
                        contents: JSON.stringify(taskOptions)
                    });
                    body.push({
                        name: 'dateCreated',
                        contents: dateC.getTime().toString()
                    });
                    if (skipPostProcessing){
                        body.push({
                            name: 'skipPostProcessing',
                            contents: "true"
                        });
                    }
                    if (webhook){
                        body.push({
                            name: 'webhook',
                            contents: webhook
                        });
                    }
                    if (outputs){
                        body.push({
                            name: 'outputs',
                            contents: outputs
                        });
                    }

                    const curl = curlInstance(resolve, reject, 
                        `${node.proxyTargetUrl()}/task/new/init?token=${node.getToken()}`,
                        body,
                        (res) => {
                            if (res.uuid !== uuid) throw new Error(`set-uuid did not match, ${res.uuid} !== ${uuid}`);
                        });
                    
                    curl.setOpt(Curl.option.HTTPHEADER, [
                        'Content-Type: multipart/form-data',
                        `set-uuid: ${uuid}`
                    ]);
                    curl.perform();
                });
            };

            const taskNewUpload = async () => {
                return new Promise((resolve, reject) => {
                    const MAX_RETRIES = 5;

                    const chunks = utils.chunkArray(fileNames, Math.ceil(fileNames.length / PARALLEL_UPLOADS));
                    let completed = 0;
                    const done = () => {
                        if (++completed >= chunks.length) resolve();
                    };
                    
                    chunks.forEach(fileNames => {
                        let retries = 0;
                        const body = fileNames.map(f => { return { name: 'images', file: path.join(tmpPath, f) } });
                        
                        const curl = curlInstance(done, async (err) => {
                                if (status.aborted) return; // Ignore if this was aborted by other code

                                if (retries < MAX_RETRIES){
                                    retries++;
                                    logger.warn(`File upload to ${node} failed, retrying... (${retries})`);
                                    await utils.sleep(2000);
                                    curl.perform();
                                }else{
                                    reject(new Error(`${err.message}: maximum upload retries (${MAX_RETRIES}) exceeded`));
                                }
                            },
                            `${node.proxyTargetUrl()}/task/new/upload/${uuid}?token=${node.getToken()}`,
                            body,
                            (res) => {
                                if (!res.success) throw new Error(`no success flag in task upload response`);
                            });

                        curl.perform();
                    });
                });
            };

            const taskNewCommit = async () => {
                return new Promise((resolve, reject) => {
                    const curl = curlInstance(resolve, reject, `${node.proxyTargetUrl()}/task/new/commit/${uuid}?token=${node.getToken()}`);
                    curl.perform();
                });
            };

            let retries = 0;
            let status = {
                aborted: false
            };
            let dmHostname = null;
            eventEmitter.on('abort', () => {
                status.aborted = true;
            });

            const abortTask = () => {
                eventEmitter.emit('abort');
                if (dmHostname && autoscale){
                    const asr = asrProvider.get();
                    try{
                        asr.destroyMachine(dmHostname);
                    }catch(e){
                        logger.warn(`Could not destroy machine ${dmHostname}: ${e}`);
                    }
                }
            };

            const handleError = async (err) => {
                const taskTableEntry = await tasktable.lookup(uuid);
                if (taskTableEntry){
                    const taskInfo = taskTableEntry.taskInfo;
                    if (taskInfo){
                        taskInfo.status.code = statusCodes.FAILED;
                        await tasktable.add(uuid, { taskInfo, output: [err.message] }, token);
                        logger.warn(`Cannot forward task ${uuid} to processing node ${node}: ${err.message}`);
                    }
                }
                
                // Only cleanup temp directory for non-Tapis nodes
                // Tapis nodes handle their own cleanup after upload retries complete
                const TapisNode = require('./classes/TapisNode');
                if (!(node instanceof TapisNode)) {
                    utils.rmdir(tmpPath);
                }
                
                eventEmitter.emit('close');
            };

            const doUpload = async () => {
                const MAX_UPLOAD_RETRIES = 5;
                eventEmitter.emit('close');

                try{
                    await taskNewInit();
                    await taskNewUpload();
                    await taskNewCommit();
                }catch(e){
                    // Attempt to retry
                    if (retries < MAX_UPLOAD_RETRIES){
                        retries++;
                        logger.warn(`Attempted to forward task ${uuid} to processing node ${node} but failed with: ${e.message}, attempting again (retry: ${retries})`);
                        await utils.sleep(1000 * 5 * retries);

                        // If autoscale is enabled, simply retry on same node
                        // otherwise switch to another node
                        if (!autoscale){
                            const newNode = await nodes.findBestAvailableNode(imagesCount, true);
                            if (newNode){
                                node = newNode;
                                logger.warn(`Switched ${uuid} to ${node}`);
                            }else{
                                // No nodes available
                                logger.warn(`No other nodes available to process ${uuid}, we'll retry the same one.`);
                            }
                        }

                        await doUpload();
                    }else{
                        throw new Error(`Failed to forward task to processing node after ${retries} attempts. Try again later.`);
                    }
                }
            };

            // Add item to task table
            await tasktable.add(uuid, { taskInfo, abort: abortTask, output: ["Launching... please wait! This can take a few minutes."] }, token);

            // Send back response to user right away
            utils.json(res, { uuid });

            if (autoscale){
                logger.info(`[TAPIS DEBUG] Attempting autoscale node creation`);
                const asr = asrProvider.get();
                try{
                    dmHostname = asr.generateHostname(imagesCount);
                    logger.info(`[TAPIS DEBUG] Generated hostname: ${dmHostname}, calling asr.createNode`);
                    node = await asr.createNode(req, imagesCount, token, dmHostname, status);
                    logger.info(`[TAPIS DEBUG] Node created successfully: ${node ? node.constructor.name : 'null'}`);
                    
                    // Debug: Check if files still exist after node creation
                    try {
                        const fs = require('fs');
                        const filesAfterNodeCreation = fs.readdirSync(tmpPath);
                        logger.info(`[TAPIS DEBUG] Files in tmpPath AFTER node creation: ${filesAfterNodeCreation.join(', ')}`);
                    } catch (e) {
                        logger.error(`[TAPIS DEBUG] Cannot read tmpPath AFTER node creation: ${e.message}`);
                    }
                    
                    if (!status.aborted) nodes.add(node);
                    else return;
                }catch(e){
                    const err = new Error("No nodes available (attempted to autoscale but failed). Try again later.");
                    logger.error(`[TAPIS DEBUG] Cannot create node via autoscaling: ${e.message}`);
                    logger.error(`[TAPIS DEBUG] Stack trace: ${e.stack}`);
                    handleError(err);
                    return;
                }
            }

            try{
                // Check if this is a Tapis node
                const TapisNode = require('./classes/TapisNode');
                if (node instanceof TapisNode) {
                    // For Tapis nodes, submit job instead of uploading files
                    await node.setCurrentTask(uuid);
                    
                    try {
                        // IMPORTANT: The upload happens inside submitJob
                        // We must wait for it to completely finish before continuing
                        await node.submitJob(imagesCount, taskOptions, fileNames, tmpPath);
                        
                        // Only after upload succeeds, clean up and respond
                        await routetable.add(uuid, node, token);
                        await tasktable.delete(uuid);
                        
                        // Don't clean up tmpPath here - TapisNode will handle cleanup after upload completes
                        eventEmitter.emit('close');
                        
                    } catch (submitError) {
                        // If Tapis upload fails, let TapisNode handle its own cleanup
                        logger.error(`[TAPIS DEBUG] Tapis upload failed: ${submitError.message}`);
                        // Don't delete tmpPath here - TapisNode will handle cleanup after retries
                        throw submitError;
                    }
                } else {
                    // Regular node processing
                    await doUpload();
                    eventEmitter.emit('close');

                    await routetable.add(uuid, node, token);
                    await tasktable.delete(uuid);

                    utils.rmdir(tmpPath);
                }
                
                // Clean up global directory tracking
                if (global.taskProcessingDirs) {
                    global.taskProcessingDirs.delete(tmpPath);
                    logger.info(`[TAPIS DEBUG] Removed directory ${tmpPath} from processing, remaining dirs: ${global.taskProcessingDirs.size}`);
                }
            }catch(e){
                // Clean up global directory tracking on error
                if (global.taskProcessingDirs) {
                    global.taskProcessingDirs.delete(tmpPath);
                    logger.info(`[TAPIS DEBUG] Removed directory ${tmpPath} from processing (error), remaining dirs: ${global.taskProcessingDirs.size}`);
                }
                handleError(e);
            }
        }else{
            throw new Error("No nodes available");
        }
    }
};