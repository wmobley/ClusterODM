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

const uuidv4 = require('uuid/v4');
const fs = require('fs');
const async = require('async');
const logger = require('./logger');
const Readable = require('stream').Readable;
const rimraf = require('rimraf');
const path = require('path');
const config = require('../config');

const resolveTmpRoot = () => {
    const dir = config.tmp_dir && config.tmp_dir.length ? config.tmp_dir : 'tmp';
    if (path.isAbsolute(dir)) return dir;
    return path.join(process.cwd(), dir);
};

const TMP_ROOT = resolveTmpRoot();
try{
    fs.mkdirSync(TMP_ROOT, { recursive: true });
}catch(e){
    logger.warn(`Cannot create tmp root ${TMP_ROOT}: ${e.message}`);
}

const tmpUploadsMap = {}; // tmp dir entries --> number of files
const tmpCleanupFailures = {}; // tmp dir entries --> last cleanup warning timestamp

const NFS_BUSY_WARN_INTERVAL_MS = 1000 * 60 * 30;

const shouldLogCleanupFailure = (dir) => {
    const now = Date.now();
    const last = tmpCleanupFailures[dir] || 0;
    if (now - last >= NFS_BUSY_WARN_INTERVAL_MS) {
        tmpCleanupFailures[dir] = now;
        return true;
    }
    return false;
};

const hasNfsTempFiles = async (dir) => {
    try {
        const entries = await fs.promises.readdir(dir);
        return entries.some(entry => entry.startsWith('.nfs'));
    } catch (_) {
        return false;
    }
};

module.exports = {
	get: function(scope, prop, defaultValue){
		let parts = prop.split(".");
		let current = scope;
		for (let i = 0; i < parts.length; i++){
			if (current[parts[i]] !== undefined && i < parts.length - 1){
				current = current[parts[i]];
			}else if (current[parts[i]] !== undefined && i < parts.length){
				return current[parts[i]];
			}else{
				return defaultValue;
			}
		}	
		return defaultValue;
    },
    
    tmpRoot: function(){
        return TMP_ROOT;
    },

    temporaryFilePath: function(){
        return path.join(TMP_ROOT, uuidv4());
    },

    uuidv4: function(){
        return uuidv4();
    },

    shuffleArray: function(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    },

    cleanupTemporaryDirectory: async function(staleUploadsTimeout = 0){
        const self = this;

        logger.info(`[TAPIS DEBUG] cleanupTemporaryDirectory called with timeout: ${staleUploadsTimeout}`);

        let entries;
        try {
            entries = await fs.promises.readdir(TMP_ROOT);
        } catch (err) {
            logger.error(err);
            throw err;
        }

        for (let entry of entries){
            if (entry === '.gitignore') continue;

            let stale = false;
            let tmpPath = path.join(TMP_ROOT, entry);
            logger.debug(`[TAPIS DEBUG] Checking directory for cleanup: ${tmpPath}`);

            if (global.taskProcessingDirs?.has(tmpPath)) {
                logger.info(`[TAPIS DEBUG] Skipping cleanup of ${tmpPath} - task still marked as processing`);
                continue;
            }

            if (await hasNfsTempFiles(tmpPath)) {
                if (shouldLogCleanupFailure(tmpPath)) {
                    logger.warn(`[TAPIS DEBUG] Skipping cleanup of ${tmpPath} - NFS .nfs* files are still open by another process`);
                }
                continue;
            }

            if (staleUploadsTimeout > 0){
                try{
                    // Check if directory has a Tapis upload lock file
                    const lockFile = path.join(tmpPath, '.tapis_upload_in_progress');
                    if (fs.existsSync(lockFile)) {
                        logger.info(`[TAPIS DEBUG] Skipping cleanup of ${tmpPath} - Tapis upload in progress`);
                        continue;
                    }
                    
                    const fileCount = await self.filesCount(tmpPath);

                    if (tmpUploadsMap[entry] === undefined){
                        tmpUploadsMap[entry] = {
                            fileCount, 
                            lastUpdated: new Date().getTime(),
                            committed: false
                        };
                    }else{
                        const prevFileCount = tmpUploadsMap[entry].fileCount;
                        stale = !tmpUploadsMap[entry].committed && 
                                prevFileCount === fileCount && 
                                (new Date().getTime() - tmpUploadsMap[entry].lastUpdated > 1000 * 60 * 60 * staleUploadsTimeout);

                        // Update if the count has changed
                        if (prevFileCount !== fileCount){
                            tmpUploadsMap[entry].fileCount = fileCount;
                            tmpUploadsMap[entry].lastUpdated = new Date().getTime();
                        }
                    }
                }catch(e){
                    logger.error(e);
                }
            }
            
            try {
                const stats = await fs.promises.stat(tmpPath);
                const mtime = new Date(stats.mtime);
                if (stale || (new Date().getTime() - mtime.getTime() > 1000 * 60 * 60 * 48)){
                    logger.info("Cleaning up " + entry + " " + (stale ? "[stale]" : ""));
                    await new Promise(resolve => {
                        self.rmfr(tmpPath, err => {
                            if (err) {
                                const message = err.message || String(err);
                                const nfsBusy = err.code === 'EBUSY' || message.includes('Device or resource busy') || message.includes('.nfs');
                                if (nfsBusy) {
                                    if (shouldLogCleanupFailure(tmpPath)) {
                                        logger.warn(`[TAPIS DEBUG] Cleanup deferred for ${tmpPath} - NFS file still busy`);
                                    }
                                } else {
                                    logger.error(err);
                                }
                            } else {
                                delete tmpCleanupFailures[tmpPath];
                            }
                            resolve();
                        });
                    });
                    delete (tmpUploadsMap[entry]);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') logger.error(err);
            }
        }
        
        // Remove entries in the upload map that aren't in tmp dir
        // to avoid memory leaks
        for (let entry of Object.keys(tmpUploadsMap)){
            if (entries.indexOf(entry) === -1){
                delete (tmpUploadsMap[entry]);
            }
        }
    },

    markTaskAsCommitted: function(taskId){
        // Avoid mistakely deleting a task's
        // files while they are being uploaded to a node
        if (tmpUploadsMap[taskId] !== undefined){
            tmpUploadsMap[taskId].committed = true;
        }
    },

    filesCount: async function(dir){
        return new Promise((resolve, reject) => {
            fs.readdir(dir, (err, files) => {
                if (err) reject(err);
                else resolve(files.length);
            });
        });
    },

    stringToStream: function(str){
        const s = new Readable();
        s._read = () => {}; // redundant? see update below
        s.push(str);
        s.push(null);
        return s;
    },

     // min and max included
    randomIntFromInterval: function(min,max){
        return Math.floor(Math.random()*(max-min+1)+min);
    },

    rmdir: function(dir){
        logger.info(`[TAPIS DEBUG] DELETING DIRECTORY: ${dir}`);
        const stack = new Error().stack;
        logger.info(`[TAPIS DEBUG] Deletion called from: ${stack.split('\n').slice(1,4).join('\n')}`);
        
        fs.exists(dir, exists => {
            if (exists){
                this.rmfr(dir, err => {
                    if (err) logger.warn(`Cannot delete ${dir}: ${err}`);
                });
            }
        });
    },

    // rm -fr implementation. dir is not checked, so this could wipe out your system.
    rmfr: function(dir, cb){
        if (fs.rm) {
            return fs.rm(dir, { recursive: true, force: true }, cb);
        }
        return rimraf(dir, cb);
    },

    // JSON helper for responses
    json: (res, json) => {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify(json));
    },

    sanitize: function(filePath){
        return filePath.replace(/(\/|\\)/g, "_");
    },

    sleep: async function(msecs){
        return new Promise((resolve) => setTimeout(resolve, msecs));
    },

    clone: function(json){
        return JSON.parse(JSON.stringify(json));
    },

    chunkArray: function(arr, chunk_size){
        var index = 0;
        var arrayLength = arr.length;
        var tempArray = [];
        
        for (index = 0; index < arrayLength; index += chunk_size) {
            let myChunk = arr.slice(index, index+chunk_size);
            tempArray.push(myChunk);
        }
    
        return tempArray;
    }
};
