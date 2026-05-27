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
"use strict";
const HttpProxy = require('http-proxy');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const Busboy = require('busboy');
const fs = require('fs');
const nodes = require('./nodes');
const ValueCache = require('./classes/ValueCache');
const config = require('../config');
const utils = require('./utils');
const netutils = require('./netutils');
const routetable = require('./routetable');
const tasktable = require('./tasktable');
const logger = require('./logger');
const statusCodes = require('./statusCodes');
const taskNew = require('./taskNew');
const async = require('async');
const odmOptions = require('./odmOptions');
const asrProvider = require('./asrProvider');
const floodMonitor = require('./floodMonitor');
const concurrencyMonitor = require('./concurrencyMonitor');
const AWS = require('aws-sdk');

const TMP_ROOT = utils.tmpRoot ? utils.tmpRoot() : path.join(process.cwd(), 'tmp');

module.exports = {
    initialize: async function(cloudProvider){
        utils.cleanupTemporaryDirectory(config.stale_uploads_timeout);
        await routetable.initialize();
        await tasktable.initialize();

        setInterval(() => {
            utils.cleanupTemporaryDirectory(config.stale_uploads_timeout);
        }, 1000 * 60 * 30);

        // Allow index, .css and .js files to be retrieved from nodes
        // without authentication
        const publicPath = (p) => {
            for (let ext of [".css", ".js", ".woff", ".ttf", ".ico"]){
                if (p.substr(-ext.length) === ext){
                    return true;
                }
            }
            return false;
        };

        // Paths that are forwarded as-is, without additional logic
        // (but require authentication)
        const directPath = (p) => {
            if (p === '/') return true;

            return false;
        };

        // JSON helper for responses
        const json = utils.json;

        const normalizeAddress = (addr) => {
            if (!addr) return '';
            if (addr.startsWith('::ffff:')) return addr.substring(7);
            return addr;
        };

        const isPrivateIPv4 = (ip) => {
            if (!ip) return false;
            const parts = ip.split('.').map(Number);
            if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
            if (parts[0] === 10) return true;
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
            if (parts[0] === 192 && parts[1] === 168) return true;
            if (parts[0] === 169 && parts[1] === 254) return true;
            return false;
        };

        const isPrivateIPv6 = (ip) => {
            if (!ip) return false;
            if (ip === '::1') return true;
            return ip.startsWith('fc') || ip.startsWith('fd');
        };

        const isInternalRequest = (remoteAddress, localAddress) => {
            const remote = normalizeAddress(remoteAddress);
            const local = normalizeAddress(localAddress);

            if (!remote) return false;
            if (remote === '127.0.0.1' || remote === '::1') return true;
            if (local && remote === local) return true;
            if (isPrivateIPv4(remote) || isPrivateIPv6(remote)) return true;

            return false;
        };

        const forwardToReferenceNode = (req, res) => {
            const referenceNode = nodes.referenceNode();
            if (referenceNode){
                proxy.web(req, res, { target: referenceNode.proxyTargetUrl() });
            }else{
                json(res, {error: "No nodes available"});
            }
        };

        const withProviderOptions = async (baseOptions, token) => {
            const provider = asrProvider.get();
            if (!provider || typeof provider.getClusterOptions !== 'function') return baseOptions;

            try {
                const providerOptions = await provider.getClusterOptions(token);
                if (!Array.isArray(providerOptions) || providerOptions.length === 0) return baseOptions;

                const providerOptionNames = new Set(providerOptions.map(option => option.name));
                const filteredBaseOptions = baseOptions.filter(option => !providerOptionNames.has(option.name));
                return filteredBaseOptions.concat(providerOptions);
            } catch (e) {
                logger.warn(`[TAPIS DEBUG] Could not append provider task options: ${e.message}`);
                return baseOptions;
            }
        };

        const getLimitedOptions = async (token, limits, node) => {
            const cacheValue = optionsCache.get(token);
            if (cacheValue) return cacheValue;

            if (!node) {
                // For ASR providers without reference nodes, use default ODM options
                const defaultOptions = [
                    {
                        "name": "auto-boundary",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Automatically set a boundary using camera shot locations to limit the area of the reconstruction."
                    },
                    {
                        "name": "boundary",
                        "type": "string",
                        "value": "",
                        "domain": "json",
                        "help": "Set a boundary using a GeoJSON polygon to limit the area of the reconstruction."
                    },
                    {
                        "name": "crop",
                        "type": "float",
                        "value": "3",
                        "domain": "",
                        "help": "Automatically crop image outputs by creating a smooth buffer around the dataset boundaries, shrunk by N meters."
                    },
                    {
                        "name": "pc-classify",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Classify the point cloud and generate a DEM"
                    },
                    {
                        "name": "pc-rectify",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Perform ground rectification on the point cloud."
                    },
                    {
                        "name": "pc-filter",
                        "type": "float",
                        "value": "2.5",
                        "domain": "",
                        "help": "Filters the point cloud by removing points that deviate more than N standard deviations from the local mean."
                    },
                    {
                        "name": "pc-quality",
                        "type": "string",
                        "value": "medium",
                        "domain": ["ultra", "high", "medium", "low", "lowest"],
                        "help": "Set point cloud quality. Higher quality generates better, denser point clouds, but requires more memory and takes longer."
                    },
                    {
                        "name": "feature-quality",
                        "type": "string",
                        "value": "high",
                        "domain": ["ultra", "high", "medium", "low", "lowest"],
                        "help": "Set feature extraction quality. Higher quality generates better features, but requires more memory and takes longer."
                    },
                    {
                        "name": "feature-type",
                        "type": "string",
                        "value": "sift",
                        "domain": ["akaze", "hahog", "orb", "sift"],
                        "help": "Choose the algorithm for extracting keypoints and computing descriptors."
                    },
                    {
                        "name": "matcher-type",
                        "type": "string",
                        "value": "flann",
                        "domain": ["bruteforce", "flann", "bow"],
                        "help": "Matcher algorithm, Fast Library for Approximate Nearest Neighbors or Bag of Words."
                    },
                    {
                        "name": "orthophoto-resolution",
                        "type": "float",
                        "value": "5",
                        "domain": "",
                        "help": "Orthophoto resolution in cm / pixel."
                    },
                    {
                        "name": "orthophoto-target-srs",
                        "type": "string",
                        "value": "",
                        "domain": "",
                        "help": "Target spatial reference system. Accepts EPSG codes, WKT and PROJ strings."
                    },
                    {
                        "name": "orthophoto-compression",
                        "type": "string",
                        "value": "DEFLATE",
                        "domain": ["JPEG", "LZW", "PACKBITS", "DEFLATE", "LZMA", "NONE"],
                        "help": "Set the compression to use for orthophotos."
                    },
                    {
                        "name": "dem-resolution",
                        "type": "float",
                        "value": "5",
                        "domain": "",
                        "help": "DSM/DTM resolution in cm / pixel."
                    },
                    {
                        "name": "texturing-data-term",
                        "type": "string",
                        "value": "gmi",
                        "domain": ["gmi", "area"],
                        "help": "Data term: [area, gmi]. Default is gmi (Gradient Magnitude Inconsistency) which works well for most cases."
                    },
                    {
                        "name": "gcp",
                        "type": "string",
                        "value": "",
                        "domain": "json",
                        "help": "Path to the file containing the ground control points used for georeferencing."
                    },
                    {
                        "name": "use-3dmesh",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Use a full 3D mesh to compute the orthophoto instead of a 2.5D mesh."
                    },
                    {
                        "name": "skip-3dmodel",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Skip generation of a full 3D model. This can save time if you only need 2D results such as orthophotos and DEMs."
                    },
                    {
                        "name": "optimize-disk-space",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Delete heavy intermediate files to optimize disk space usage."
                    },
                    {
                        "name": "dtm",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Use this tag to build a DTM (Digital Terrain Model, ground only) using a simple morphological filter."
                    },
                    {
                        "name": "dsm",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Use this tag to build a DSM (Digital Surface Model, ground + objects) using a progressive morphological filter."
                    },
                    {
                        "name": "force-gps",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Use GPS information from EXIF even if a GCP file is provided."
                    },
                    {
                        "name": "gps-accuracy",
                        "type": "float",
                        "value": "10",
                        "domain": "",
                        "help": "Set a value in meters for the GPS Dilution of Precision (DOP) information for all images."
                    },
                    {
                        "name": "ignore-gsd",
                        "type": "bool",
                        "value": "false",
                        "domain": "",
                        "help": "Ignore Ground Sampling Distance (GSD). GSD caps the maximum resolution of image outputs."
                    },
                    {
                        "name": "max-concurrency",
                        "type": "int",
                        "value": "4",
                        "domain": "",
                        "help": "The maximum number of processes to use in various processes. Peak memory requirement is ~1GB per thread and 2 megapixel image resolution."
                    },
                    {
                        "name": "min-num-features",
                        "type": "int",
                        "value": "10000",
                        "domain": "",
                        "help": "Minimum number of features to extract per image. More features lead to better results but slower execution."
                    },
                    {
                        "name": "camera-lens",
                        "type": "string",
                        "value": "auto",
                        "domain": ["auto", "perspective", "brown", "fisheye", "spherical", "equirectangular"],
                        "help": "Set a camera lens model. By default the application tries to determine a lens model from the images."
                    },
                    {
                        "name": "radiometric-calibration",
                        "type": "string",
                        "value": "none",
                        "domain": ["none", "camera", "camera+sun"],
                        "help": "Set the radiometric calibration to perform on images. When processing multispectral and thermal images you should set this option to obtain reflectance/temperature values."
                    },
                    {
                        "name": "primary-band",
                        "type": "string",
                        "value": "auto",
                        "domain": "",
                        "help": "When processing multispectral datasets, you can specify the name of the primary band that will be used for reconstruction."
                    },
                    {
                        "name": "split",
                        "type": "int",
                        "value": "1",
                        "domain": "",
                        "help": "Average number of images per submodel. Set to a positive integer to enable split-merge processing for large datasets. When set to 1, ODM will automatically determine the optimal split size."
                    },
                    {
                        "name": "split-overlap",
                        "type": "float",
                        "value": "150",
                        "domain": "",
                        "help": "Overlap between submodels in meters. Ensures accurate tie points and georeferencing across submodel boundaries. Recommended: 100-200m for typical drone surveys."
                    },
                    {
                        "name": "sm-cluster",
                        "type": "string",
                        "value": "",
                        "domain": "",
                        "help": "URL of the split-merge cluster coordinator. Automatically set by ClusterODM when using distributed processing. Leave empty for single-machine processing."
                    }
                ];
                const optionsWithProvider = await withProviderOptions(defaultOptions, token);
                const limitedOptions = odmOptions.optionsWithLimits(optionsWithProvider, limits.options);
                return optionsCache.set(token, limitedOptions);
            }

            const options = await node.getOptions();
            const optionsWithProvider = await withProviderOptions(options, token);
            const limitedOptions = odmOptions.optionsWithLimits(optionsWithProvider, limits.options);
            return optionsCache.set(token, limitedOptions);
        };

        const maxConcurrencyLimitReached = async (maxConcurrentTasks, token) => {
            if (maxConcurrentTasks === 0) return true;
            if (!maxConcurrentTasks) return false;

            const provider = asrProvider.get();
            if (provider && typeof provider.countActiveJobsForToken === 'function' && token){
                try{
                    const activeJobs = await provider.countActiveJobsForToken(token);
                    logger.info(`[TAPIS DEBUG] Tapis active job count=${activeJobs}, maxConcurrentTasks=${maxConcurrentTasks}`);
                    return activeJobs >= maxConcurrentTasks;
                }catch(e){
                    logger.warn(`[TAPIS DEBUG] Could not count active Tapis jobs, falling back to ClusterODM route table: ${e.message}`);
                }
            }

            const userRoutes = await routetable.findByToken(token);
            let runningTasks = 0;
            await new Promise((resolve) => {
                async.each(Object.keys(userRoutes), (taskId, cb) => {
                    (userRoutes[taskId]).node.taskInfo(taskId).then((taskInfo) => {
                        if (taskInfo.status && [statusCodes.QUEUED, statusCodes.RUNNING].indexOf(taskInfo.status.code) !== -1) runningTasks++;
                        cb();
                    });
                }, resolve);
            });
            
            return runningTasks >= maxConcurrentTasks;
        };

        const getReqBody = async (req) => {
            return new Promise((resolve, reject) => {
                let body = [];
                req.on('data', (chunk) => {
                    body.push(chunk);
                }).on('end', () => {
                    resolve(Buffer.concat(body).toString());
                });
            });
        };

        // Replace token 
        const previewToken = (token) => {
            if (!token) return 'none';
            if (token.length <= 6) return token;
            return `${token.substring(0,6)}…${token.substring(token.length - 4)}`;
        };

        const overrideRequest = (req, node, query, pathname) => {
            if (node.getToken()){
                // Override token. When requests come in through
                // the proxy, the token is the user's token
                // but when we redirect them to a node
                // the token is specific to the node.
                query.token = node.getToken();
            }

            req.url = url.format({ query, pathname });
        };

        const proxy = new HttpProxy();
        const optionsCache = new ValueCache({expires: 60 * 60 * 1000});

        const publicApiPaths = new Set(['/info', '/options']);

        const pathHandlers = {
            '/info': function(req, res, user){
                const limits = user && user.limits ? user.limits : {};
                const node = nodes.referenceNode();
                
                json(res, {
                    version: "1.5.3", // this is the version we speak
                    taskQueueCount: 0,
                    totalMemory: 99999999999, 
                    availableMemory: 99999999999,
                    cpuCores: 99999999999,
                    maxImages: limits.maxImages || null,
                    maxParallelTasks: limits.maxConcurrentTasks !== undefined ? limits.maxConcurrentTasks : 99999999999,
                    engineVersion: node !== undefined ? node.getInfo().engineVersion : '?',
                    engine: node !== undefined ? node.getInfo().engine : '?'
                });
            },

            '/options': async function(req, res, user){
                const token = user ? user.token : null;
                const limits = user && user.limits ? user.limits : {};
                const node = nodes.referenceNode();
                const options = await getLimitedOptions(token, limits, node);

                let adjustedOptions = options;
                if (Array.isArray(options)){
                    adjustedOptions = options.map(opt => {
                        if (!opt || typeof opt !== 'object') return opt;

                        const clone = Object.assign({}, opt);
                        if (clone.name === 'sm-cluster'){
                            const clusterBase =
                                (config.public_address && config.public_address.trim()) ||
                                (config.cluster_address && config.cluster_address.trim()) ||
                                (() => {
                                    const forwardedHost = req.headers['x-forwarded-host'];
                                    if (forwardedHost){
                                        const proto = req.headers['x-forwarded-proto'] || (config.use_ssl ? 'https' : 'http');
                                        return `${proto}://${forwardedHost}`;
                                    }
                                    if (req.headers.host){
                                        return `${config.use_ssl ? 'https' : 'http'}://${req.headers.host}`;
                                    }
                                    return null;
                                })();

                            if (clusterBase){
                                clone.value = clusterBase.replace(/\/+$/, '');
                            }
                        }
                        return clone;
                    });
                }

                json(res, adjustedOptions);
            }
        }

        // Listen for the `error` event on `proxy`.
        proxy.on('error', function (err, req, res) {
            // If the error is caused by a connection issue,
            // we actually simulate the same behavior by dropping the connection
            // because returning an error could make a NodeODM client assume that something failed
            if (res.socket && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')){
                logger.warn(`Proxy redirect error: ${err.message}`);
                res.socket.destroy();
            }else{
                json(res, {error: `Proxy redirect error: ${err.message}`});
            }
        });

        // Added for CORS support
        var enableCors = function(req, res) {
          if (req.headers['access-control-request-method']) {
              res.setHeader('access-control-allow-methods', req.headers['access-control-request-method']);
          }

          if (req.headers['access-control-request-headers']) {
              res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers']);
          }

          if (req.headers.origin) {
              res.setHeader('access-control-allow-origin', req.headers.origin);
              res.setHeader('access-control-allow-credentials', 'true');
          }
        };

        const requestListener = async function (req, res) {
            enableCors(req, res);

            try{
                const urlParts = url.parse(req.url, true);
                const { query, pathname } = urlParts;
                
                let authOptional = publicApiPaths.has(pathname);

                const connection = req.socket || req.connection;
                const rawRemoteAddress = connection && connection.remoteAddress;
                const rawLocalAddress = connection && connection.localAddress;
                const remoteAddress = normalizeAddress(rawRemoteAddress);
                const localAddress = normalizeAddress(rawLocalAddress);
                const isDownloadRequest = pathname.startsWith('/task/') && pathname.indexOf('/download/') !== -1;

                if (!authOptional &&
                    config.allow_local_download_bypass &&
                    isDownloadRequest &&
                    isInternalRequest(remoteAddress, localAddress)){
                    authOptional = true;
                    logger.debug(`[TAPIS DEBUG] Allowing JWT bypass for internal download ${pathname} from ${remoteAddress || 'unknown'}`);
                }

                if (isDownloadRequest){
                    logger.info(`[TAPIS DEBUG] Download request ${pathname} from=${remoteAddress || 'unknown'} local=${localAddress || 'unknown'} token_present=${query.token ? 'yes' : 'no'} bypass=${authOptional}`);
                }

                // Extract token from Authorization header if not in query params
                if (!query.token && req.headers.authorization) {
                    const authHeader = req.headers.authorization;
                    if (authHeader.startsWith('Bearer ')) {
                        query.token = authHeader.substring(7); // Remove 'Bearer ' prefix
                    }
                } else if (!query.token && !authOptional) {
                    logger.info(`[TAPIS DEBUG] No JWT token provided for ${pathname}`);
                }

                if (publicPath(pathname)){
                    forwardToReferenceNode(req, res);
                    return;
                }

                if (req.method === 'POST' && pathname === '/commit'){
                    const body = await getReqBody(req);
                    try{
                        const taskInfo = JSON.parse(body);
                        const taskId = taskInfo.uuid;

                        asrProvider.onCommit(taskId, 10 * 1000);
                        
                        // Add reference to S3 path if necessary
                        if (asrProvider.downloadsPath()){
                            taskInfo.s3Path = asrProvider.downloadsPath();
                        }
                        
                        const token = await routetable.lookupToken(taskId);
                        concurrencyMonitor.decreaseCount(token);
                        
                        try{
                            cloudProvider.taskFinished(token, taskInfo);
                        }catch(e){
                            logger.error(`cloudProvider.taskFinished: ${e.message}`);
                        }

                        json(res, {ok: true});
                    }catch(e){
                        logger.warn(`Malformed /commit request: ${body}`);
                        json(res, {error: "Malformed /commit request"});
                    }

                    return;
                }

                if (pathname === '/auth/info'){
                    cloudProvider.handleAuthInfo(req, res);
                    return;
                }

                let userContext = null;
                let limits = {};

                if (!authOptional || query.token){
                    const validation = await cloudProvider.validate(query.token);
                    limits = validation.limits || {};

                    if (!validation.valid || query._debugUnauthorized){
                        if (authOptional){
                            logger.debug(`[TAPIS DEBUG] Invalid or missing token for optional endpoint ${pathname}, continuing without authentication`);
                            limits = {};
                        }else{
                            res.writeHead(401, "unauthorized");
                            res.end();
                            return;
                        }
                    }else{
                        userContext = { token: query.token, limits };
                    }
                }else{
                    limits = {};
                }

                if (directPath(pathname)){
                    forwardToReferenceNode(req, res);
                    return;
                }

                if (pathHandlers[pathname]){
                    (pathHandlers[pathname])(req, res, userContext);
                    return;
                }

                if (req.method === 'POST' && pathname === '/task/new/init'){
                    let ctx = null;
                    try{
                        ctx = await taskNew.createContext(req, res);
                    }catch(e){
                        json(res, {error: e.message});
                        return;
                    }

                    const { uuid, tmpPath, die } = ctx;

                    logger.info(`[TAPIS DEBUG] proxy.js - tmpPath: ${tmpPath}, limits: ${JSON.stringify(limits)}`);
                    logger.info(`[TAPIS DEBUG] proxy.js - calling formDataParser from /task/new/init handler`);

                    taskNew.formDataParser(req, async function(params){
                        logger.info(`[TAPIS DEBUG] formDataParser callback called with params:`, {
                            fileNames: params.fileNames,
                            imagesCount: params.imagesCount,
                            error: params.error,
                            taskName: params.taskName
                        });
                        
                        const { options } = params;
                        if (params.error){
                            die(params.error);
                            return;
                        }

                        logger.info(`[TAPIS DEBUG] Checking nodes and autoscale...`);
                        const referenceNode = nodes.referenceNode();
                        const asrProvider = require('./asrProvider');
                        const canAutoscale = asrProvider.isAllowedToCreateNewNodes();
                        
                        logger.info(`[TAPIS DEBUG] referenceNode: ${referenceNode ? 'exists' : 'null'}, canAutoscale: ${canAutoscale}`);
                        
                        if (!referenceNode && !canAutoscale){
                            logger.error(`[TAPIS DEBUG] No nodes available and can't autoscale`);
                            die("Cannot create task, no nodes are online.");
                            return;
                        }
                        
                        // If we have no reference node but can autoscale, we'll create one later
                        if (!referenceNode && canAutoscale) {
                            logger.info(`[TAPIS DEBUG] No reference node but can autoscale - proceeding with task creation`);
                        }

                        logger.info(`[TAPIS DEBUG] Checking concurrency limits...`);
                        if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, query.token)){
                            // TODO: A better solution would be to put the task in a queue
                            // but it's non-trivial to keep such a state, as well as to deal
                            // with scalability of storage requirements.
                            logger.error(`[TAPIS DEBUG] Reached max concurrent tasks: ${limits.maxConcurrentTasks}`);
                            die(`Reached maximum number of concurrent tasks: ${limits.maxConcurrentTasks}. Please wait until other tasks have finished, then restart the task.`);
                            return;
                        }
                        logger.info(`[TAPIS DEBUG] Concurrency check passed`);

                        logger.info(`[TAPIS DEBUG] About to call taskNew.process...`);

                        // Validate options
                        try{
                            logger.info(`[TAPIS DEBUG] Validating options...`);
                            odmOptions.filterOptions(options, await getLimitedOptions(query.token, limits, referenceNode || null));
                            logger.info(`[TAPIS DEBUG] Options validation passed`);
                        }catch(e){
                            logger.error(`[TAPIS DEBUG] Options validation failed: ${e.message}`);
                            die(e.message);
                            return;
                        }

                        logger.info(`[TAPIS DEBUG] Recording task and checking flood...`);
                        floodMonitor.recordTaskInit(query.token);
                        
                        if (floodMonitor.isFlooding(query.token)){
                            logger.error(`[TAPIS DEBUG] Flooding detected`);
                            die(`Uuh, slow down! It seems like you are sending a lot of tasks. Check that your connection is not dropping, or wait ${floodMonitor.FORGIVE_TIME} minutes and try again.`);
                            return;
                        }

                        logger.info(`[TAPIS DEBUG] Saving body.json and copying files to UUID directory...`);
                        
                        // Copy files from random temp dir to UUID dir
                        // If an import_path was provided, skip copying uploaded files - path-based tasks should not touch files
                        if (!params.import_path && params.fileNames && params.fileNames.length > 0 && global.lastTempDir) {
                            const srcDir = global.lastTempDir;
                            logger.info(`[TAPIS DEBUG] Copying files from ${srcDir} to ${tmpPath}`);
                            
                            params.fileNames.forEach(fileName => {
                                const srcFile = path.join(srcDir, fileName);
                                const dstFile = path.join(tmpPath, fileName);
                                if (fs.existsSync(srcFile)) {
                                    try {
                                        fs.copyFileSync(srcFile, dstFile);
                                        logger.info(`[TAPIS DEBUG] Copied ${fileName}`);
                                    } catch (e) {
                                        logger.error(`[TAPIS DEBUG] Failed to copy ${fileName}: ${e.message}`);
                                    }
                                }
                            });
                        }
                        
                        // Save
                        fs.writeFile(path.join(tmpPath, "body.json"),
                                    JSON.stringify(params), {encoding: 'utf8'}, err => {
                            if (err) {
                                logger.error(`[TAPIS DEBUG] Failed to save body.json: ${err.message}`);
                                json(res, { error: err });
                            } else{
                                logger.info(`[TAPIS DEBUG] Saved body.json, returning UUID: ${uuid}`);
                                // All good
                                json(res, { uuid });
                            }
                        });
                    });
                }else if (req.method === 'POST' && pathname.indexOf('/task/new/upload') === 0){
                    // Destroy sockets after 30s of inactivity
                    req.setTimeout(30000, () => {
                        req.destroy();
                    });

                    const taskId = taskNew.getTaskIdFromPath(pathname);
                    if (taskId){
                        const saveFilesToDir = path.join(TMP_ROOT, taskId);
                        async.series([
                            cb => {
                                fs.exists(saveFilesToDir, exists => {
                                    if (!exists) cb(new Error("Invalid taskId: the task no longer exists."));
                                    else cb();
                                });
                            },
                            cb => {
                                if (limits && limits.maxImages){
                                    // Check if we've exceeding image limits
                                    fs.readdir(saveFilesToDir, (err, files) => {
                                        if (err){
                                            logger.warn(`Failed to read files from ${saveFilesToDir}`);
                                            cb();
                                        }else if (files.length - 1 > limits.maxImages){
                                            // -1 accounts for _body.json
                                            cb(new Error("Max images count exceeded."));
                                        }else{
                                            cb();
                                        }
                                    });
                                }else{
                                    // No limits
                                    cb();
                                }
                            },
                            cb => {
                                taskNew.formDataParser(req, function(params){
                                    const totalFiles = Array.isArray(params.fileNames) ? params.fileNames.length : 0;
                                    if (!params.imagesCount && totalFiles === 0) cb(new Error("No files uploaded."));
                                    else if (params.error) cb(new Error(params.error));
                                    else cb();
                                }, { saveFilesToDir, parseFields: true});
                            }
                        ], err => {
                            if (err) json(res, {error: err.message});
                            else json(res, {success: true});
                        });
                    }else json(res, { error: `No uuid found in ${pathname}`});
                }else if (req.method === 'POST' && pathname.indexOf('/task/new/commit') === 0){
                    const taskId = taskNew.getTaskIdFromPath(pathname);
                    if (taskId){
                        const tmpPath = path.join(TMP_ROOT, taskId);
                        const bodyFile = path.join(tmpPath, 'body.json');
                        const die = (err) => {
                            utils.rmdir(tmpPath);
                            utils.json(res, {error: err});
                            asrProvider.cleanup(taskId);
                        };

                        if (concurrencyMonitor.checkCommitLimitReached(limits.maxConcurrentTasks, query.token)){
                            die(`Reached maximum number of concurrent tasks, please wait until other tasks have finished, then restart the task.`);
                            return;
                        }

                        if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, query.token)){
                            die(`Reached maximum number of concurrent tasks. Please wait until other tasks have finished, then restart the task.`);
                            return;
                        }


                        floodMonitor.recordTaskCommit(query.token);
                        utils.markTaskAsCommitted(taskId);

                        async.series([
                            cb => {
                                fs.readFile(bodyFile, 'utf8', (err, data) => {
                                    if (err) cb(err);
                                    else{
                                        try{
                                            const body = JSON.parse(data);
                                            cb(null, body);
                                        }catch(e){
                                            cb(new Error(`Cannot commit task ${e.message}`));
                                        }
                                    }
                                });
                            },

                            cb => {
                                fs.readdir(tmpPath, (err, files) => {
                                    if (err) cb(err);
                                    else cb(null, files.filter(f => f.toLowerCase() !== "body.json"));
                                });
                            }
                        ], async (err, [ body, files ]) => {
                            if (err) json(res, {error: err.message});
                            else{
                                body.fileNames = files;
                                body.imagesCount = files.length;

                                try{
                                    await taskNew.process(req, res, cloudProvider, taskId, body, query.token, limits, getLimitedOptions);
                                }catch(e){
                                    die(e.message);
                                    return;
                                }
                            }
                        });
                    }else json(res, { error: `No uuid found in ${pathname}`});
                }else if (req.method === 'POST' && pathname === '/task/new') {
                    let ctx = null;
                    try{
                        ctx = await taskNew.createContext(req, res);
                    }catch(e){
                        json(res, {error: e.message});
                        return;
                    }

                    const { uuid, tmpPath, die } = ctx;

                    taskNew.formDataParser(req, async function(params) {
                        if (params.error){
                            die(params.error);
                            return;
                        }

                        if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, query.token)){
                            die(`Reached maximum number of concurrent tasks: ${limits.maxConcurrentTasks}. Please wait until other tasks have finished, then restart the task.`);
                            return;
                        }

                        try{
                            logger.info(`[TAPIS DEBUG] Calling taskNew.process with uuid: ${uuid}, fileNames: ${params.fileNames.length}`);
                            await taskNew.process(req, res, cloudProvider, uuid, params, query.token, limits, getLimitedOptions);
                            logger.info(`[TAPIS DEBUG] taskNew.process completed successfully`);
                        }catch(e){
                            logger.error(`[TAPIS DEBUG] taskNew.process failed: ${e.message}`);
                            logger.error(`[TAPIS DEBUG] Stack: ${e.stack}`);

                            // Check if this is a token expiration error
                            if (e.message.includes('JWT token expired') || e.message.includes('token is invalid or expired')) {
                                res.status(401).json({
                                    error: "Authentication expired",
                                    message: "Your session has expired. Please login again.",
                                    details: e.message,
                                    redirect: "/login"
                                });
                                return;
                            }

                            die(e.message);
                            return;
                        }
                    }, { saveFilesToDir: tmpPath, limits, uuid });
                }else if (req.method === 'POST' && ['/task/restart', '/task/cancel', '/task/remove'].indexOf(pathname) !== -1){
                    // Lookup task id from body
                    let taskId = null;
                    let body = await getReqBody(req);

                    const handleTaskAction = async () => {
                        if (taskId){
                            concurrencyMonitor.decreaseCount(query.token);

                            let node = await routetable.lookupNode(taskId);
                            if (node){
                                overrideRequest(req, node, query, pathname);
                                proxy.web(req, res, { 
                                        target: node.proxyTargetUrl(),
                                        buffer: utils.stringToStream(body)
                                    });
                            }else{
                                const taskTableEntry = await tasktable.lookup(taskId);
                                if (taskTableEntry && taskTableEntry.taskInfo){
                                    if (pathname === '/task/cancel' || pathname === '/task/remove'){
                                        if (taskTableEntry.abort){
                                            taskTableEntry.abort();
                                            taskTableEntry.abort = null;
                                            logger.info(`Task ${taskId} aborted via ${pathname}`);
                                        }
                                        
                                        utils.rmdir(`tmp/${taskId}`);

                                        if (pathname === '/task/remove'){
                                            await tasktable.delete(taskId);
                                        }

                                        if (pathname === '/task/cancel'){
                                            taskTableEntry.taskInfo.status.code = statusCodes.CANCELED;
                                            await tasktable.add(taskId, taskTableEntry, query.token);
                                        }

                                        json(res, { success: true });
                                    }else{
                                        json(res, { error: `Action not supported. Please create a new task.` });
                                    }
                                }else{
                                    json(res, { error: `Invalid route for taskId ${taskId}, no nodes in routing table.`});
                                }
                            }
                        }else{
                            json(res, { error: `No uuid found in ${pathname}`});
                        }
                    };

                    const contentType = (req.headers['content-type'] || '').toLowerCase();
                    if (contentType.includes('application/json')){
                        try{
                            const parsed = JSON.parse(body || '{}');
                            taskId = parsed.uuid || parsed.taskId || null;
                        }catch(e){
                            logger.warn(`[TAPIS DEBUG] Failed to parse JSON body for ${pathname}: ${e.message}`);
                        }
                        await handleTaskAction();
                        return;
                    }

                    try{
                        const busboy = new Busboy({ headers: req.headers });
                        busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                            if (fieldname === 'uuid'){
                                taskId = val;
                            }
                        });
                        busboy.on('finish', async function() {
                            await handleTaskAction();
                        });

                        utils.stringToStream(body).pipe(busboy);
                    }catch(e){
                        logger.warn(`[TAPIS DEBUG] Failed to parse multipart body for ${pathname}: ${e.message}`);
                        await handleTaskAction();
                    }
                }else if (req.method === 'GET' && pathname === '/task/list') {
                    const taskIds = {};
                    const taskTableEntries = await tasktable.findByToken(query.token);
                    for (let taskId in taskTableEntries){
                        taskIds[taskId] = true;
                    }

                    const routeTableEntries = await routetable.findByToken(query.token, true);
                    for (let taskId in routeTableEntries){
                        taskIds[taskId] = true;
                    }
                    
                    json(res, Object.keys(taskIds).map(uuid => { return { uuid } }));
                }else{
                    // Lookup task id
                    const matches = pathname.match(/^\/task\/([\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+)\/(.+)$/);
                    if (matches && matches[1]){
                        const taskId = matches[1];
                        const action = matches[2];

                        // Special case for /task/<uuid>/download/<asset> if 
                        // we need to redirect to S3. In that case, we rewrite
                        // the URL to fetch from S3.
                        const downloadsPath = asrProvider.downloadsPath();
                        const forceNodeDownloads = !!config.force_node_downloads;
                        const node = await routetable.lookupNode(taskId);
                        const isDownloadAction = action && action.indexOf('download') === 0;
                        const isTapisNode = node && node.constructor && node.constructor.name === 'TapisNode';
                        const tapisNodeHasRegisteredTarget = isTapisNode && node.nodeRegistered && node.hostname && node.port;
                        const nodeProxyTarget = node && typeof node.proxyTargetUrl === 'function' ? node.proxyTargetUrl() : null;
                        const nodeOnline = node && typeof node.isOnline === 'function' ? node.isOnline() : false;
                        const nodeCanServeDownload = isDownloadAction && node && nodeProxyTarget && nodeOnline && (!isTapisNode || tapisNodeHasRegisteredTarget);
                        const asrInstance = asrProvider.get();
                        const asrDriver = asrInstance && typeof asrInstance.getDriverName === 'function' ? asrInstance.getDriverName() : null;
                        const downloadsPathEnabled = !forceNodeDownloads && downloadsPath && asrDriver !== 'tapis';

                        if (isDownloadAction){
                            logger.info(`[TAPIS DEBUG] Download routing decision task=${taskId} node=${node ? node.constructor.name : 'none'} online=${nodeOnline} registered=${tapisNodeHasRegisteredTarget} canServe=${nodeCanServeDownload} downloadsPathEnabled=${downloadsPathEnabled}`);
                        }

                        if (isDownloadAction && !downloadsPathEnabled && downloadsPath && asrDriver === 'tapis'){
                            logger.debug(`[TAPIS DEBUG] Skipping downloadsPath redirect for Tapis provider`);
                        }

                        if (downloadsPathEnabled && isDownloadAction && !nodeCanServeDownload){
                            const assetsMatch = action.match(/^download\/(.+)$/);
                            if (assetsMatch && assetsMatch[1]){
                                let assetPath = assetsMatch[1];

                                // Special case for orthophoto.tif
                                if (assetPath === 'orthophoto.tif') assetPath = 'odm_orthophoto/odm_orthophoto.tif';

                                const s3Url = url.parse(downloadsPath);
                                s3Url.pathname = path.join(taskId, assetPath);

                                const getConfig = asrInstance && typeof asrInstance.getConfig === 'function' ? asrInstance.getConfig.bind(asrInstance) : null;
                                const s3Config = getConfig ? getConfig("s3") : null;

                                // If URL requires authentication, fetch the object on their behalf and then stream it to them
                                // If our aws library gets updated to v3, then we could return a redirect to a presigned url instead 
                                if (s3Config && s3Config.acl !== undefined && s3Config.acl !== "public-read") {
                                    const accessKey = getConfig ? getConfig("accessKey") : null;
                                    const secretKey = getConfig ? getConfig("secretKey") : null;

                                    if (accessKey && secretKey) {
                                        logger.info(`[TAPIS DEBUG] Streaming secured asset ${assetPath} for ${taskId} from ${s3Config.endpoint}`);
                                        let key = path.join(taskId, assetPath)

                                        const s3 = new AWS.S3({
                                            endpoint: new AWS.Endpoint(s3Config.endpoint),
                                            signatureVersion: 'v4',
                                            accessKeyId: accessKey,
                                            secretAccessKey: secretKey
                                        });

                                        s3.getObject({ Bucket: s3Config.bucket, Key: key }, (err, data) => {
                                            if (err) {
                                              logger.error(`Error encountered downloading object ${err}`);
                                              res.statusCode = 500;
                                              res.end('Internal server error');
                                              return;
                                            }

                                            // Set the content-type and content-length headers
                                            res.setHeader('Content-Type', data.ContentType);
                                            res.setHeader('Content-Length', data.ContentLength);

                                            // Write the object data to the response
                                            res.write(data.Body);
                                            res.end();
                                        });
                                        return;
                                    } else {
                                        logger.warn(`[TAPIS DEBUG] Missing access credentials for secured asset ${assetPath}; cannot stream from ${s3Config.endpoint}`);
                                    }
                                }

                                logger.info(`[TAPIS DEBUG] Redirecting download ${pathname} to ${url.format(s3Url)}`);
                                res.writeHead(301, {
                                    'Location': url.format(s3Url)
                                });
                                res.end();
                                return;
                            }
                        }

                        if (node){
                            // Special handling for TapisNode - handle requests internally when no direct node is registered yet
                            if (isTapisNode && !tapisNodeHasRegisteredTarget) {
                                logger.info(`[TAPIS DEBUG] Handling TapisNode request internally: ${pathname}`);
                                
                                try {
                                    if (action === 'info') {
                                        const info = await node.taskInfo(taskId);
                                        json(res, info);
                                        return;
                                    } else if (action === 'output') {
                                        const line = parseInt(query.line) || 0;
                                        const output = await node.taskOutput(taskId, line);
                                        json(res, output);
                                        return;
                                    } else if (action === 'cancel') {
                                        const result = await node.taskCancel(taskId);
                                        json(res, result);
                                        return;
                                    } else if (action === 'remove') {
                                        const result = await node.taskRemove(taskId);
                                        json(res, result);
                                        return;
                                    } else if (action && action.indexOf('download') === 0) {
                                        // Handle file downloads
                                        const assetsMatch = action.match(/^download\/(.+)$/);
                                        if (assetsMatch && assetsMatch[1]) {
                                            const asset = assetsMatch[1];
                                            const downloadPath = await node.taskDownload(taskId, asset);
                                            // Stream the file
                                            const fs = require('fs');
                                            const stat = fs.statSync(downloadPath);
                                            res.writeHead(200, {
                                                'Content-Type': 'application/zip',
                                                'Content-Length': stat.size
                                            });
                                            const readStream = fs.createReadStream(downloadPath);
                                            readStream.pipe(res);
                                            return;
                                        }
                                    }
                                    
                                    // Unsupported action
                                    json(res, { error: `Action ${action} not supported for TapisNode` });
                                    return;
                                } catch (e) {
                                    logger.error(`[TAPIS DEBUG] TapisNode request failed: ${e.message}`);
                                    json(res, { error: e.message });
                                    return;
                                }
                            } else {
                                if (isDownloadAction){
                                    logger.info(`[TAPIS DEBUG] Forwarding download ${pathname} to ${node.proxyTargetUrl()} with token=${previewToken(node.getToken())}`);
                                }else{
                                    logger.debug(`[TAPIS DEBUG] Forwarding ${pathname} to ${node.proxyTargetUrl()} with token=${previewToken(node.getToken())}`);
                                }
                                // Regular node - use HTTP proxy
                                overrideRequest(req, node, query, pathname);
                                // Log task/info forwarding explicitly for visibility
                                if (action === 'info'){
                                    logger.warn(`[TAPIS DEBUG] Proxying /task/${taskId}/info to ${node.proxyTargetUrl()} with token=${previewToken(node.getToken())}`);
                                }
                                proxy.web(req, res, { target: node.proxyTargetUrl() });
                            }
                        }else{
                            const taskTableEntry = await tasktable.lookup(taskId);
                            if (taskTableEntry){

                                // GET: /task/<uuid>/info
                                if (action === 'info'){
                                    logger.warn(`[TAPIS DEBUG] /task/${taskId}/info requested (cached=${!!taskTableEntry.taskInfo}) query=${JSON.stringify(query)}`);
                                    let response = taskTableEntry.taskInfo;

                                    // If taskInfo is missing or incomplete, try live fetch via route table with node token.
                                    const needsLiveFetch = !response || !response.status || response.status.code === undefined;
                                    if (needsLiveFetch) {
                                        try {
                                            const route = await routetable.find(taskId);
                                            if (route && route.node) {
                                                const targetUrl = `${route.node.proxyTargetUrl()}${pathname}?token=${route.node.getToken() || ''}`;
                                                logger.warn(`[TAPIS DEBUG] Task ${taskId} has no cached info; fetching live from ${targetUrl}`);
                                                const axiosResp = await axios.get(targetUrl, { timeout: 10000 });
                                                return json(res, axiosResp.data || {});
                                            }
                                        } catch (liveErr) {
                                            logger.warn(`[TAPIS DEBUG] Live fetch fallback failed for ${taskId}: ${liveErr.message}`);
                                        }
                                    }

                                    // ?with_output support
                                    if (query.with_output !== undefined){
                                        const line = parseInt(query.with_output) || 0;
                                        const output = taskTableEntry.output || [];
                                        response.output = output.slice(line, output.length);
                                    }

                                    // Populate processingTime if needed
                                    if (response.processingTime === undefined){
                                        response = utils.clone(response);
                                        if (response.dateCreated && response.status && response.status.code === statusCodes.RUNNING){
                                            response.processingTime = (new Date().getTime()) - response.dateCreated;
                                        }else{
                                            response.processingTime = -1;
                                        }
                                    }

                                    json(res, response);

                                // GET: /task/<uuid>/output
                                }else if (action === 'output'){
                                    const line = query.line || 0;
                                    const output = taskTableEntry.output || [];
                                    json(res, output.slice(line, output.length));
                                }else{
                                    json(res, { error: `Invalid route for taskId ${taskId}:${action}, no valid route possible.`});
                                }
                            }else{
                                json(res, { error: `Invalid route for taskId ${taskId}:${action}, no task table entry.`});
                            }
                        }
                    }else{
                        json(res, { error: `Cannot handle ${pathname}`});
                    }
                }
            }catch(e){
                logger.warn(`Uncaught exception: ${e}`);
                json(res, { error: 'exception'});
                if (config.debug) throw e;
            }
        };

        const servers = [{
            server: http.createServer(requestListener),
            secure: false
        }];

        if (config.use_ssl){
            servers.push({
                server: https.createServer({
                    key: fs.readFileSync(config.ssl_key, 'utf8'),
                    cert: fs.readFileSync(config.ssl_cert, 'utf8')
                }, requestListener),
                secure: true
            });
        }

        return servers;
    }
};
