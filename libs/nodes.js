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
const Node = require('./classes/Node');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const utils = require('./utils');

const DATA_DIR = 'data';
const DATA_FILE = path.join(DATA_DIR, 'nodes.json');
const TEMP_DATA_FILE = `${DATA_FILE}.tmp`;

let nodes = [];
let initialized = false;

const parseNonNegativeIntEnv = (envName, fallback) => {
    const parsed = parseInt(process.env[envName], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

module.exports = {
    initialize: async function(){
        if (initialized) throw new Error("Already initialized");

        await this.loadFromDisk();
        this.updateInfo();
        logger.info(`Loaded ${nodes.length} nodes`);

        setInterval(() => {
            this.updateInfo()
        }, 60 * 1000);

        initialized = true;
    },

    addUnique: function(hostname, port, token){
        if (!hostname || !port) return false;

        if (!nodes.find(n => n.hostname() === hostname && n.port() === port)){
            const node = new Node(hostname, port, token);
            this.add(node);
            return node;
        }else{
            return false;
        }
    },

    add: function(node){
        nodes.push(node);
        logger.debug(`Added node: ${node}`);
        this.saveToDisk();
        return node;
    },

    remove: function(node){
        if (node){
            nodes = nodes.filter(n => n !== node);
            logger.debug(`Removed node: ${node}`);
            this.saveToDisk();
            return true;
        }else{
            return false;
        }
    },

    lock: function(node){
        if (node){
            node.setLocked(true);
            this.saveToDisk();
            return true;
        }else{
            return false;
        }
    },

    unlock: function(node){
        if (node){
            node.setLocked(false);
            this.saveToDisk();
            return true;
        }else{
            return false;
        }
    },

    all: function(){
        return nodes;
    },

    find: function(match){
        return nodes.find(match);
    },

    filter: function(match){
        return nodes.filter(match);
    },

    nth: function(n){
        n = parseInt(n);
        if (isNaN(n)) return null;

        n -= 1;
        if (n >= 0 && n < nodes.length){
            return nodes[n];
        }else return null;
    },

    online: function(){
        return nodes.filter(n => n.isOnline());
    },

    updateInfo: async function(){
        return await Promise.all(nodes.map(n => n.updateInfo()));
    },

    // Reference node is the one used to generate
    // node information for the proxy (for example,
    // when returning calls to /info or /options)
    referenceNode: function(){
        return nodes.find(n => n.isOnline());
    },

    maxTurnNumber: function(){
        return Math.max(...nodes.map(n => n.turn));
    },

    clearTurnNumbers: function(){
        nodes.forEach(n => n.turn = 0);
    },

    findBestAvailableNode: async function(numImages, update = false){
        if (update) await this.updateInfo();

        let maxTurnNumber = this.maxTurnNumber();
        if (maxTurnNumber > 2000000000){
            this.clearTurnNumbers();
            maxTurnNumber = 0;
        }

        const candidates = nodes.filter(n => n.isOnline() && 
                                             !n.isLocked() &&
                                             !n.isAutoSpawned() &&
                                            (!n.getInfo().maxImages || n.getInfo().maxImages >= numImages));
        if (!candidates.length) return null;

        let sorted = candidates.map(n => {
            return {
                node: n,
                maxImages: n.getInfo().maxImages ? n.getInfo().maxImages : 999999999,
                slots: n.availableSlots(),
                queueCount: n.getInfo().taskQueueCount
            };
        });

        // Sort by node with smallest maxImages value
        // tie break by most available slots
        // and further by least queue count
        // and further by turn number
        sorted.sort((a, b) => {
            if (a.maxImages < b.maxImages) return -1;
            else if (a.maxImages > b.maxImages) return 1;
            else if (a.slots > b.slots) return -1;
            else if (a.slots < b.slots) return 1;
            else if (a.queueCount < b.queueCount) return -1;
            else if (a.queueCount > b.queueCount) return 1;
            else if (a.node.turn < b.node.turn) return -1;
            else if (a.node.turn > b.node.turn) return 1;
            else return 1;
        });
        
        let bestNode = null;
        for (let i = 0; i < sorted.length; i++){
            if (sorted[i].slots > 0) {
                bestNode = sorted[i].node;
                break;
            }
        }

        // All nodes are full, pick the first
        if (!bestNode) bestNode = sorted[0].node;
        bestNode.turn = maxTurnNumber + 1;
        return bestNode;
    },

    findBestAvailableNodeWithRetry: async function(numImages, update = false, options = {}){
        const maxRetries = options.maxRetries !== undefined ? options.maxRetries : parseNonNegativeIntEnv('CLUSTERODM_NODE_SELECTION_MAX_RETRIES', 12);
        const retryDelayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : parseNonNegativeIntEnv('CLUSTERODM_NODE_SELECTION_RETRY_DELAY_MS', 5000);
        const taskId = options.taskId || 'unknown';
        const logFn = typeof options.logFn === 'function' ? options.logFn : null;
        const retryWhenNoNodes = options.retryWhenNoNodes === true;

        for (let attempt = 0; attempt <= maxRetries; attempt++){
            const node = await this.findBestAvailableNode(numImages, update);
            if (node) {
                if (attempt > 0) {
                    const message = `Found available node for ${taskId} after ${attempt} retry attempt(s): ${node}`;
                    if (logFn) logFn(message);
                    else logger.info(`[NODES] ${message}`);
                }
                return node;
            }

            if ((!nodes.length && !retryWhenNoNodes) || attempt >= maxRetries) return null;

            const reason = nodes.length ? 'No eligible node available' : 'No nodes registered';
            const message = `${reason} for ${taskId}; retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${maxRetries})`;
            if (logFn) logFn(message, 'warn');
            else logger.warn(`[NODES] ${message}`);
            if (retryDelayMs <= 0) continue;
            await utils.sleep(retryDelayMs);
        }

        return null;
    },

    saveToDisk: async function(){
        return new Promise((resolve, reject) => {
            fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
                if (mkErr){
                    logger.warn(`Cannot prepare data directory for nodes: ${mkErr.message}`);
                    reject(mkErr);
                    return;
                }

                const payload = JSON.stringify(nodes);
                fs.writeFile(TEMP_DATA_FILE, payload, (tmpErr) => {
                    if (tmpErr){
                        logger.warn(`Cannot write temporary nodes file: ${tmpErr.message}`);
                        reject(tmpErr);
                    }else{
                        const finalize = () => {
                            fs.rename(TEMP_DATA_FILE, DATA_FILE, (renameErr) => {
                                if (renameErr){
                                    logger.warn(`Cannot finalize nodes file: ${renameErr.message}`);
                                    fs.unlink(TEMP_DATA_FILE, () => {});
                                    reject(renameErr);
                                }else{
                                    resolve();
                                }
                            });
                        };

                        fs.stat(DATA_FILE, (statErr) => {
                            if (statErr){
                                if (statErr.code === 'ENOENT'){
                                    finalize();
                                }else{
                                    logger.warn(`Cannot inspect existing nodes file: ${statErr.message}`);
                                    fs.unlink(TEMP_DATA_FILE, () => {});
                                    reject(statErr);
                                }
                            }else{
                                fs.unlink(DATA_FILE, (unlinkErr) => {
                                    if (unlinkErr){
                                        logger.warn(`Cannot remove previous nodes file: ${unlinkErr.message}`);
                                        fs.unlink(TEMP_DATA_FILE, () => {});
                                        reject(unlinkErr);
                                    }else{
                                        finalize();
                                    }
                                });
                            }
                        });
                    }
                });
            });
        });
    },

    loadFromDisk: async function(){
        return new Promise((resolve, reject) => {
            fs.exists(DATA_FILE, (exists) => {
                if (!exists){
                    resolve();
                    return;
                }

                fs.readFile(DATA_FILE, 'utf8', (err, json) => {
                    if (err){
                        logger.warn(`Cannot read nodes from disk: ${err.message}`);
                        reject(err);
                        return;
                    }

                    const trimmed = (json || '').trim();
                    if (!trimmed){
                        nodes = [];
                        resolve();
                        return;
                    }

                    try{
                        const nodesjson = JSON.parse(trimmed);
                        nodes = nodesjson.map(n => Node.FromJSON(n)).filter(n => n !== null);
                        resolve();
                    }catch(parseErr){
                        logger.warn(`Cannot parse nodes from disk (${parseErr.message}). Resetting nodes list.`);

                        fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
                            if (mkErr){
                                logger.warn(`Unable to prepare data directory while handling corrupted nodes file: ${mkErr.message}`);
                            }else{
                                const backupPath = `${DATA_FILE}.corrupt-${Date.now()}`;
                                fs.writeFile(backupPath, json, backupErr => {
                                    if (backupErr){
                                        logger.warn(`Unable to write corrupted nodes backup: ${backupErr.message}`);
                                    }
                                });

                                fs.writeFile(DATA_FILE, '[]', resetErr => {
                                    if (resetErr){
                                        logger.warn(`Unable to reset nodes file: ${resetErr.message}`);
                                    }
                                });
                            }
                        });

                        nodes = [];
                        resolve();
                    }
                });
            });
        });
    },

    cleanup: async function(){
        try{
            await this.saveToDisk();
            logger.info("Saved nodes to disk");
        }catch(e){
            logger.warn(e);
        }
    }
};
