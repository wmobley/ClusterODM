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
const crypto = require('crypto');
const child_process = require('child_process');
const config = require('../config');
const Curl = require('node-libcurl').Curl;
const tasktable = require('./tasktable');
const routetable = require('./routetable');
const nodes = require('./nodes');
const odmOptions = require('./odmOptions');
const statusCodes = require('./statusCodes');
const asrProvider = require('./asrProvider');
const logger = require('./logger');
const splitLogger = require('./splitLogger');
const events = require('events');
const tapisTaskOptions = require('./tapisTaskOptions');

const TMP_ROOT = utils.tmpRoot ? utils.tmpRoot() : path.join(process.cwd(), 'tmp');

const parseBoolEnv = (envName) => {
    const envValue = process.env[envName];
    if (!envValue) return false;
    const normalized = envValue.toString().trim().toLowerCase();
    return normalized.length > 0 && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
};

const parseNonNegativeIntEnv = (envName, fallback) => {
    const parsed = parseInt(process.env[envName], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const PRESERVE_SEED_TMP = parseBoolEnv('CLUSTERODM_PRESERVE_SEED_TMP');
const PRESERVE_ALL_TMP = parseBoolEnv('CLUSTERODM_PRESERVE_UPLOADS');

const shouldPreserveTmp = (isSplitSeedTask) => {
    if (PRESERVE_ALL_TMP) return true;
    if (isSplitSeedTask && PRESERVE_SEED_TMP) return true;
    return false;
};

const maybePreserveTmp = (tmpPath, isSplitSeedTask, logFn) => {
    if (shouldPreserveTmp(isSplitSeedTask)){
        if (typeof logFn === 'function'){
            logFn(`Preserving tmpPath at ${tmpPath} (CLUSTERODM_PRESERVE_UPLOADS=${PRESERVE_ALL_TMP}, CLUSTERODM_PRESERVE_SEED_TMP=${PRESERVE_SEED_TMP})`);
        }else{
            logger.info(`[CLUSTERODM] Preserving tmpPath ${tmpPath} for debugging`);
        }
        return true;
    }
    return false;
};

if (PRESERVE_SEED_TMP){
    logger.info('[SPLIT-MERGE] CLUSTERODM_PRESERVE_SEED_TMP enabled - split seed tmp directories will be preserved after upload');
}
if (PRESERVE_ALL_TMP){
    logger.info('[CLUSTERODM] CLUSTERODM_PRESERVE_UPLOADS enabled - preserving all uploaded tmp directories');
}

const IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.pgm', '.gif'
]);

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

    // Fallback: extract UUID from request URL (e.g., /task/new/commit/:uuid)
    if (req && req.url) {
        const match = req.url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
        if (match && match[1]) {
            const urlUuid = match[1];
            const tmpDir = path.join(TMP_ROOT, urlUuid);

            // Prefer the URL UUID when a matching temp directory already exists
            if (fs.existsSync(tmpDir)) {
                return urlUuid;
            }
        }
    }

    return utils.uuidv4();
};

const hashFileSha256 = (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
});

const logSeedZipDiagnostics = async (seedPath, uuid, logFn) => {
    try {
        const stats = await fs.promises.stat(seedPath);
        const sha = await hashFileSha256(seedPath);
        const message = `Seed zip diagnostics: path=${seedPath}, size=${stats.size}, sha256=${sha}`;
        if (typeof logFn === 'function') logFn(message);
        else logger.info(message);
    } catch (err) {
        const message = `Seed zip diagnostics failed for ${seedPath}: ${err.message}`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
    }
};

const runCommand = (command, args, options = {}) => new Promise((resolve) => {
    const child = child_process.spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.on('error', error => resolve({ error, stdout, stderr }));
    if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
});

const commandExists = async (command) => {
    const result = await runCommand(command, ['-h']);
    return !result.error;
};

const waitForStableFile = async (filePath, logFn, options = {}) => {
    const maxWaitMs = options.maxWaitMs || 30000;
    const intervalMs = options.intervalMs || 500;
    const requiredStableChecks = options.requiredStableChecks || 3;
    const label = options.label || filePath;

    let lastSize = -1;
    let lastMtime = -1;
    let stableCount = 0;
    const start = Date.now();

    while (Date.now() - start <= maxWaitMs) {
        try {
            const stats = await fs.promises.stat(filePath);
            const size = stats.size;
            const mtime = stats.mtimeMs;
            if (size > 0 && size === lastSize && mtime === lastMtime) {
                stableCount += 1;
                if (stableCount >= requiredStableChecks) return true;
            } else {
                stableCount = 0;
            }
            lastSize = size;
            lastMtime = mtime;
        } catch (err) {
            stableCount = 0;
        }
        await utils.sleep(intervalMs);
    }

    const message = `Timed out waiting for stable file ${label}`;
    if (typeof logFn === 'function') logFn(message, 'warn');
    else logger.warn(message);
    return false;
};

const waitForImportPathAvailable = async (importPath, logFn, options = {}) => {
    const maxWaitMs = options.maxWaitMs !== undefined ? options.maxWaitMs : parseNonNegativeIntEnv('CLUSTERODM_IMPORT_PATH_WAIT_MS', 15000);
    const intervalMs = options.intervalMs !== undefined ? options.intervalMs : parseNonNegativeIntEnv('CLUSTERODM_IMPORT_PATH_INTERVAL_MS', 1000);

    if (!importPath) return false;
    if (maxWaitMs <= 0) return fs.existsSync(importPath);

    const start = Date.now();
    let attempts = 0;
    let lastError = null;

    while (Date.now() - start <= maxWaitMs) {
        attempts += 1;
        try {
            await fs.promises.stat(importPath);
            if (attempts > 1) {
                const message = `import_path became available after ${Date.now() - start}ms: ${importPath}`;
                if (typeof logFn === 'function') logFn(message);
                else logger.info(`[SPLIT-MERGE] ${message}`);
            }
            return true;
        } catch (err) {
            lastError = err;
            if (err.code && err.code !== 'ENOENT' && err.code !== 'ESTALE') {
                logger.warn(`[SPLIT-MERGE] import_path stat failed with non-transient error for ${importPath}: ${err.message}`);
                return false;
            }
        }

        if (intervalMs <= 0 || Date.now() - start + intervalMs > maxWaitMs) break;
        await utils.sleep(intervalMs);
    }

    const message = `import_path not accessible after ${Date.now() - start}ms (${attempts} checks): ${importPath}${lastError ? ` (${lastError.message})` : ''}`;
    if (typeof logFn === 'function') logFn(message, 'warn');
    else logger.warn(`[SPLIT-MERGE] ${message}`);
    return false;
};

const stableStringify = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const normalizeImportPathKey = (importPath) => {
    if (!importPath) return null;
    try {
        return path.resolve(String(importPath).trim());
    } catch (_) {
        return String(importPath).trim();
    }
};

const toOptionMap = (options = []) => {
    const map = new Map();
    if (!Array.isArray(options)) return map;

    options.forEach(option => {
        if (!option || option.name === undefined) return;
        map.set(String(option.name), stableStringify(option.value));
    });

    return map;
};

const taskOptionsContainRequestedValues = (existingOptions = [], requestedOptions = []) => {
    const existingMap = toOptionMap(existingOptions);
    const requestedMap = toOptionMap(requestedOptions);

    for (const [name, value] of requestedMap.entries()) {
        if (!existingMap.has(name)) return false;
        if (existingMap.get(name) !== value) return false;
    }

    return true;
};

const findMatchingPendingTask = async ({ token, importPath, taskName, requestedOptions }) => {
    const normalizedImportPath = normalizeImportPathKey(importPath);
    if (!token || !normalizedImportPath) return null;

    const queuedTasks = await tasktable.findByToken(token);
    for (const [taskId, taskEntry] of Object.entries(queuedTasks || {})) {
        const taskInfo = taskEntry && taskEntry.taskInfo;
        if (!taskInfo || !taskInfo.status) continue;
        if (![statusCodes.QUEUED, statusCodes.RUNNING].includes(taskInfo.status.code)) continue;

        const queuedImportPath = normalizeImportPathKey(taskEntry.importPath);
        if (queuedImportPath !== normalizedImportPath) continue;
        if ((taskInfo.name || '') !== (taskName || '')) continue;
        if (!taskOptionsContainRequestedValues(taskInfo.options || [], requestedOptions)) continue;

        return { uuid: taskId, source: 'tasktable' };
    }

    const provider = asrProvider.get();
    if (provider && provider.pendingTasks) {
        for (const pendingTask of provider.pendingTasks.values()) {
            if (!pendingTask || pendingTask.token !== token) continue;
            if (normalizeImportPathKey(pendingTask.pathImport) !== normalizedImportPath) continue;
            if ((pendingTask.req && pendingTask.req.body && pendingTask.req.body.name ? pendingTask.req.body.name : '') !== (taskName || '')) continue;
            if (!taskOptionsContainRequestedValues(pendingTask.taskOptions || [], requestedOptions)) continue;

            return { uuid: pendingTask.clusterTaskId || pendingTask.taskId, source: 'pendingTasks' };
        }
    }

    return null;
};

const testSeedZip = async (seedPath, logFn) => {
    let result = await runCommand('unzip', ['-t', seedPath]);
    if (result.error) {
        result = await runCommand('7z', ['t', seedPath]);
    }
    if (result.error) {
        result = await runCommand('python3', ['-m', 'zipfile', '-t', seedPath]);
    }
    if (result.error) {
        const message = `Seed zip integrity test skipped (no unzip/7z available): ${result.error.message}`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
        return { ok: true, skipped: true };
    }
    if (result.code === 0) return { ok: true };
    const detail = (result.stderr || result.stdout || '').trim();
    const message = detail ? `Seed zip integrity check failed: ${detail}` : `Seed zip integrity check failed (exit code ${result.code})`;
    if (typeof logFn === 'function') logFn(message, 'warn');
    else logger.warn(message);
    return { ok: false, message };
};

const repairSeedZip = async (seedPath, tmpPath, uuid, logFn) => {
    const has7z = await commandExists('7z');
    const hasUnzip = await commandExists('unzip');
    const hasZip = await commandExists('zip');
    const hasPython = await commandExists('python3');
    if (!has7z && !hasUnzip && !hasPython) {
        const message = `Seed zip repair skipped; no unzip/7z/python3 available for ${seedPath}`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
        return { ok: false, message };
    }
    if (!has7z && !hasZip && !hasPython) {
        const message = `Seed zip repair skipped; no zip/7z/python3 available to repackage ${seedPath}`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
        return { ok: false, message };
    }

    const repairDir = path.join(tmpPath, `seed_repair_${uuid}`);
    await fs.promises.mkdir(repairDir, { recursive: true });

    if (has7z) {
        const extract = await runCommand('7z', ['x', '-y', `-o${repairDir}`, seedPath]);
        if (extract.code !== 0) {
            const message = `Seed zip repair failed during 7z extract (exit ${extract.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    } else if (hasUnzip) {
        const extract = await runCommand('unzip', ['-o', seedPath, '-d', repairDir]);
        if (extract.code !== 0) {
            const message = `Seed zip repair failed during unzip extract (exit ${extract.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    } else if (hasPython) {
        const extract = await runCommand('python3', ['-m', 'zipfile', '-e', seedPath, repairDir]);
        if (extract.code !== 0) {
            const message = `Seed zip repair failed during python extract (exit ${extract.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    }

    const entries = await fs.promises.readdir(repairDir);
    if (!entries.length) {
        const message = `Seed zip repair produced no files for ${seedPath}`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
        return { ok: false, message };
    }

    const repairedPath = path.join(tmpPath, `seed.repaired.${uuid}.zip`);
    if (has7z) {
        const repack = await runCommand('7z', ['a', '-tzip', '-mx=0', repairedPath, '.'], { cwd: repairDir });
        if (repack.code !== 0) {
            const message = `Seed zip repair failed during 7z repack (exit ${repack.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    } else if (hasZip) {
        const repack = await runCommand('zip', ['-r', '-q', repairedPath, '.'], { cwd: repairDir });
        if (repack.code !== 0) {
            const message = `Seed zip repair failed during zip repack (exit ${repack.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    } else if (hasPython) {
        const pythonZipScript = [
            "import os, sys, zipfile",
            "out = sys.argv[1]",
            "root = sys.argv[2]",
            "with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as z:",
            "    for base, _, files in os.walk(root):",
            "        for name in files:",
            "            full = os.path.join(base, name)",
            "            rel = os.path.relpath(full, root)",
            "            z.write(full, rel)",
        ].join("\\n");
        const repack = await runCommand('python3', ['-c', pythonZipScript, repairedPath, repairDir]);
        if (repack.code !== 0) {
            const message = `Seed zip repair failed during python repack (exit ${repack.code})`;
            if (typeof logFn === 'function') logFn(message, 'warn');
            else logger.warn(message);
            return { ok: false, message };
        }
    }

    const replace = () => fs.promises.rename(repairedPath, seedPath);
    try {
        await fs.promises.unlink(seedPath);
        await replace();
    } catch (err) {
        const message = `Seed zip repair failed to replace original (${err.message})`;
        if (typeof logFn === 'function') logFn(message, 'warn');
        else logger.warn(message);
        return { ok: false, message };
    }

    const retest = await testSeedZip(seedPath, logFn);
    if (!retest.ok) return { ok: false, message: retest.message || 'Seed zip repair failed validation' };

    const message = `Seed zip repaired successfully for ${uuid}`;
    if (typeof logFn === 'function') logFn(message);
    else logger.info(message);
    return { ok: true };
};

const ensureSeedZipIntegrity = async (seedPath, tmpPath, uuid, logFn) => {
    const testResult = await testSeedZip(seedPath, logFn);
    if (testResult.ok) return { ok: true };
    const repairResult = await repairSeedZip(seedPath, tmpPath, uuid, logFn);
    return repairResult;
};

// Translate an import path from Cluster/WebODM namespace to node-local namespace.
// Looks up mappings in config.node_shared_path_mappings or config.NODE_SHARED_PATH_MAPPINGS.
const FALLBACK_SHARED_PATH_MAPPINGS = {
    '*': {
        '/corral/webodm/media': '/corral/utexas/BCS26030/webodm/media'
    }
};
const translateImportPathForNode = (importPath, nodeHostname) => {
    if (!importPath) return null;
    const mappings = config.node_shared_path_mappings || config.NODE_SHARED_PATH_MAPPINGS || FALLBACK_SHARED_PATH_MAPPINGS || {};

    const expandEnv = (val) => {
        if (typeof val !== 'string') return val;
        return val.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}/g, (_match, p1, p2) => {
            const key = p1 || p2;
            return process.env[key] || _match;
        });
    };

    // Try exact hostname, short hostname (strip domain), then wildcard '*'
    const candidates = [];
    if (nodeHostname) candidates.push(nodeHostname);
    if (nodeHostname && nodeHostname.indexOf('.') !== -1) candidates.push(nodeHostname.split('.')[0]);
    candidates.push('*');

    for (const key of candidates){
        if (!key) continue;
        const mapForHost = mappings[key];
        if (!mapForHost) continue;

        // mapForHost is an object of sourcePrefix -> destPrefix
        for (const srcPrefix in mapForHost){
            if (!srcPrefix) continue;
            const expandedSrc = expandEnv(srcPrefix);
            if (!expandedSrc) continue;
            if (importPath.indexOf(expandedSrc) === 0){
                const destPrefixRaw = mapForHost[srcPrefix];
                const destPrefix = expandEnv(destPrefixRaw);
                if (!destPrefix) continue;
                // remainder after source prefix
                let remainder = importPath.substring(expandedSrc.length);
                // ensure there's a separator between destPrefix and remainder if needed
                if (remainder && !remainder.startsWith(path.sep) && !destPrefix.endsWith(path.sep)){
                    remainder = path.sep + remainder;
                }
                // Build translated path
                let translated = destPrefix + remainder;
                // Normalize and ensure it still begins with destPrefix
                translated = path.normalize(translated);
                const normalizedDest = path.normalize(destPrefix);
                if (translated.indexOf(normalizedDest) === 0){
                    return translated;
                }
            }
        }
    }

    // If no mapping matched, return the original path (normalized) so nodes that already
    // share the same storage layout can still use import_path without translation.
    return path.normalize(importPath);
};

const parseNodeTaskResponse = (resp) => {
    if (!resp) throw new Error('node response missing data');
    const data = resp.data !== undefined ? resp.data : resp;
    if (!data) throw new Error('node response missing data');
    if (data.error) throw new Error(data.error);
    if (!data.uuid) {
        let snippet = '';
        try{
            snippet = ` (${JSON.stringify(data).slice(0, 200)})`;
        }catch(_){}
        throw new Error(`node response missing uuid${snippet}`);
    }
    return data;
};

const countImagesInDirectory = async (dirPath) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        let total = 0;

        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += await countImagesInDirectory(entryPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (IMAGE_EXTENSIONS.has(ext)) total++;
            }
        }

        return total;
    } catch (err) {
        logger.warn(`[TAPIS DEBUG] Failed to inspect directory ${dirPath}: ${err.message}`);
        throw err;
    }
};

const countImagesForImportPath = async (importPath) => {
    if (!importPath) return 0;
    try {
        const stats = await fs.promises.stat(importPath);
        if (stats.isFile()) {
            const ext = path.extname(importPath).toLowerCase();
            return IMAGE_EXTENSIONS.has(ext) ? 1 : 0;
        } else if (stats.isDirectory()) {
            return await countImagesInDirectory(importPath);
        } else {
            logger.warn(`[TAPIS DEBUG] import_path ${importPath} is neither file nor directory`);
        }
    } catch (err) {
        logger.warn(`[TAPIS DEBUG] Cannot stat import_path ${importPath}: ${err.message}`);
    }
    return 0;
};

module.exports = {
    // @return {object} Context object with methods and variables to use during task/new operations 
    createContext: async function(req, res){
        let uuid = await getUuid(req);

        const tmpPath = path.join(TMP_ROOT, uuid);
        const curlLogPath = path.join(tmpPath, 'curl.log');
        const globalCurlLogPath = path.join(process.cwd(), 'curl.log');
        let curlLogStream = null;
        let globalCurlLogStream = null;

        if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath);
        const appendCurlLog = (line) => {
            try{
                if (!curlLogStream){
                    curlLogStream = fs.createWriteStream(curlLogPath, { flags: 'a' });
                }
                curlLogStream.write(`${(new Date()).toISOString()} ${line}\n`);
                if (!globalCurlLogStream){
                    globalCurlLogStream = fs.createWriteStream(globalCurlLogPath, { flags: 'a' });
                }
                globalCurlLogStream.write(`${(new Date()).toISOString()} [${uuid}] ${line}\n`);
            }catch(e){
                logger.warn(`[TAPIS DEBUG] Unable to write curl log ${curlLogPath}: ${e.message}`);
            }
        };

        // Track if response has been sent to prevent double responses
        let responseSent = false;
        
        return {
            uuid, 
            tmpPath,
            // Expose for downstream logging of curl requests/responses
            appendCurlLog,
            die: (err) => {
                if (responseSent) {
                    logger.warn(`[TAPIS DEBUG] Attempted to send response after already sent: ${err}`);
                    return;
                }
                responseSent = true;
                if (!maybePreserveTmp(tmpPath, false)) {
                    utils.rmdir(tmpPath);
                }
                utils.json(res, {error: err});
                asrProvider.cleanup(uuid);
            },
            markResponseSent: () => {
                responseSent = true;
            },
            isResponseSent: () => responseSent,
            closeCurlLogs: () => {
                if (curlLogStream){
                    try{
                        curlLogStream.end();
                    }catch(e){
                        logger.warn(`[TAPIS DEBUG] Unable to close curl log ${curlLogPath}: ${e.message}`);
                    }
                    curlLogStream = null;
                }
                if (globalCurlLogStream){
                    try{
                        globalCurlLogStream.end();
                    }catch(e){
                        logger.warn(`[TAPIS DEBUG] Unable to close global curl log ${globalCurlLogPath}: ${e.message}`);
                    }
                    globalCurlLogStream = null;
                }
            }
        };
    },

    formDataParser: function(req, onFinish, options = {}){
        logger.info(`[TAPIS DEBUG] formDataParser called with ${arguments.length} arguments`);
        logger.info(`[TAPIS DEBUG] formDataParser arg[2] (options): ${JSON.stringify(arguments[2])}`);
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
        let requestAborted = false;
        
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

                // Support path-based import (shared filesystem) - clients may post import_path
                else if ((fieldname === 'import_path' || fieldname === 'importPath') && val){
                    params.import_path = val;
                    logger.info(`[TAPIS DEBUG] Detected import_path field: ${val}`);
                }
    
                else if (fieldname === 'skipPostProcessing' && val === 'true'){
                    params.skipPostProcessing = val;
                }

                else if (fieldname === 'outputs' && val){
                    params.outputs = val;
                    logger.info(`[TAPIS DEBUG] Parsed outputs field for task "${params.taskName || 'unnamed'}": ${val}`);
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
                        const shouldDelete = !uploadCompleted &&
                                             !global.taskProcessingDirs?.has(tmpDir) &&
                                             (requestAborted || !requestEnded);
                        
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
                    req.on('abort', () => {
                        logger.info(`[TAPIS DEBUG] Request abort event triggered`);
                        requestAborted = true;
                        handleClose();
                    });

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
        
        req.on('aborted', () => {
            logger.info(`[TAPIS DEBUG] Request stream aborted`);
            requestAborted = true;
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

    augmentTaskOptions: function(req, taskOptions, limits, token, imagesCount = 0){
        if (typeof taskOptions === "string") taskOptions = JSON.parse(taskOptions);
        if (!Array.isArray(taskOptions)) taskOptions = [];
        let odmOptions = [];

        let autoSplitApplied = false;
        let autoSplitValue = null;
        let autoUseExifApplied = false;
        let autoRerunFromApplied = false;
        let foundTokenValue = null;

        if (config.splitmerge){
            // We automatically set the "sm-cluster" parameter
            // to match the address that was used to reach ClusterODM.
            // if "--split" is set.
            const clusterUrl = netutils.publicAddressPath('/', req, token);

            let foundSplit = false, foundSMCluster = false;
            let foundToken = false;
            let foundUseExif = false;
            let foundRerunFrom = false;
            taskOptions.forEach(to => {
                if (to.name === 'split'){
                    foundSplit = true;
                    odmOptions.push({name: to.name, value: to.value});
                }else if (to.name === 'sm-cluster'){
                    foundSMCluster = true;
                    odmOptions.push({name: to.name, value: clusterUrl});
                }else if (to.name === 'token'){
                    foundToken = true;
                    foundTokenValue = to.value;
                    odmOptions.push({name: to.name, value: to.value});
                }else if (to.name === 'use-exif'){
                    foundUseExif = true;
                    odmOptions.push({name: to.name, value: to.value});
                }else if (to.name === 'rerun-from'){
                    foundRerunFrom = true;
                    odmOptions.push({name: to.name, value: to.value});
                }else{
                    odmOptions.push({name: to.name, value: to.value});
                }
            });

            // Auto-enable split for large datasets (50+ images) to match Tapis configuration
            if (!foundSplit && imagesCount >= 50) {
                logger.info(`[SPLIT-MERGE] Auto-enabling split for large dataset (${imagesCount} images)`);
                foundSplit = true;

                // Determine desired split size using ASR submission plan when available
                let desiredSubmodels = null;
                const asr = asrProvider.get();
                if (asr && typeof asr.calculateNodeSubmissionPlan === 'function') {
                    try {
                        const plan = asr.calculateNodeSubmissionPlan(imagesCount, taskOptions);
                        if (plan) {
                            const concurrencyHint = plan.totalWorkerNodes || plan.nodesToSubmit || plan.nodesForJob;
                            if (concurrencyHint && concurrencyHint > 1) {
                                desiredSubmodels = concurrencyHint;
                                logger.info(`[SPLIT-MERGE] Using ASR submission plan concurrency=${desiredSubmodels}`);
                            }
                        }
                    } catch (e) {
                        logger.warn(`[SPLIT-MERGE] Failed to inspect ASR submission plan: ${e.message}`);
                    }
                }

                // Fallback heuristic aims for ~75 images per submodel
                let splitNumeric;
                const DEFAULT_SPLIT_TARGET = 75;
                if (desiredSubmodels && desiredSubmodels > 1) {
                    splitNumeric = Math.ceil(imagesCount / desiredSubmodels);
                } else {
                    splitNumeric = DEFAULT_SPLIT_TARGET;
                }

                const MIN_SPLIT_SIZE = 30;
                splitNumeric = Math.max(MIN_SPLIT_SIZE, splitNumeric);
                splitNumeric = Math.min(splitNumeric, Math.max(imagesCount - 1, MIN_SPLIT_SIZE));

                const splitValue = splitNumeric.toString();
                logger.info(`[SPLIT-MERGE] Setting split value=${splitValue} (images=${imagesCount}, desiredSubmodels=${desiredSubmodels || 'fallback'})`);
                autoSplitApplied = true;
                autoSplitValue = splitValue;
                odmOptions.push({name: 'split', value: splitValue});

                // Add split-overlap for photogrammetric accuracy
                // Use 150m overlap for drone datasets (conservative for typical flight heights)
                let foundSplitOverlap = false;
                taskOptions.forEach(to => {
                    if (to.name === 'split-overlap') foundSplitOverlap = true;
                });

                if (!foundSplitOverlap) {
                    const overlapMeters = '150'; // Conservative overlap for most drone datasets
                    logger.info(`[SPLIT-MERGE] Auto-setting split-overlap to ${overlapMeters}m for photogrammetric accuracy`);
                    odmOptions.push({name: 'split-overlap', value: overlapMeters});
                }

                if (!foundUseExif) {
                    logger.info(`[SPLIT-MERGE] Enabling use-exif to ensure georeferencing for split workflow`);
                    autoUseExifApplied = true;
                    odmOptions.push({ name: 'use-exif', value: true });
                }

                if (!foundRerunFrom) {
                    logger.info(`[SPLIT-MERGE] Setting rerun-from=dataset to ensure fresh split directories`);
                    autoRerunFromApplied = true;
                    odmOptions.push({ name: 'rerun-from', value: 'dataset' });
                }
            }

            if (foundSplit && !foundSMCluster){
                odmOptions.push({name: 'sm-cluster', value: clusterUrl });
            }

            const normalizedTokenValue = typeof foundTokenValue === 'string' ? foundTokenValue.trim() : foundTokenValue;
            if (!normalizedTokenValue){
                const sourceToken = (config.token && config.token.length > 0) ? config.token :
                                    (token && typeof token === 'string' && token.length > 0 ? token : null);
                if (sourceToken){
                    if (config.token && config.token.length > 0){
                        logger.info(`[TAPIS DEBUG] Injecting ClusterODM static token into split-merge options`);
                    }else{
                        logger.info(`[TAPIS DEBUG] No ClusterODM static token configured; propagating request token for split-merge auth (${sourceToken.substring(0, 8)}...)`);
                    }
                    odmOptions = odmOptions.filter(opt => opt.name !== 'token');
                    odmOptions.push({ name: 'token', value: sourceToken });
                }else{
                    logger.warn(`[TAPIS DEBUG] Split-merge request missing authentication token; downstream sm-cluster calls may fail`);
                }
            }
        }else{
            // Make sure the "sm-cluster" parameter is removed
            odmOptions = utils.clone(taskOptions.filter(to => to.name !== 'sm-cluster'));
        }

        // Enforce no EPT generation (Entwine) for LS6 runs
        const beforeLen = odmOptions.length;
        odmOptions = odmOptions.filter(opt => opt.name !== 'pc-ept');
        if (odmOptions.length !== beforeLen){
            logger.info(`[TAPIS DEBUG] Stripped pc-ept from ODM options to avoid Entwine`);
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

        // Re-apply auto split value in case limits clamped it back up
        if (autoSplitApplied && autoSplitValue !== null) {
            const splitEntry = odmOptions.find(opt => opt.name === 'split');
            if (splitEntry) {
                if (splitEntry.value !== autoSplitValue) {
                    logger.info(`[SPLIT-MERGE] Forcing split value to ${autoSplitValue} after limits adjustment (previously ${splitEntry.value})`);
                }
                splitEntry.value = autoSplitValue;
            } else {
                logger.warn(`[SPLIT-MERGE] Auto split value was removed by limits logic, re-inserting with value ${autoSplitValue}`);
                odmOptions.push({ name: 'split', value: autoSplitValue });
            }
        }
        if (autoUseExifApplied) {
            const useExifEntry = odmOptions.find(opt => opt.name === 'use-exif');
            if (useExifEntry) {
                if (useExifEntry.value !== true) {
                    logger.info(`[SPLIT-MERGE] Forcing use-exif back to true after limits adjustment (previously ${useExifEntry.value})`);
                }
                useExifEntry.value = true;
            } else {
                logger.warn(`[SPLIT-MERGE] Auto use-exif flag removed by limits logic, re-inserting`);
                odmOptions.push({ name: 'use-exif', value: true });
            }
        }
        if (autoRerunFromApplied) {
            const rerunFromEntry = odmOptions.find(opt => opt.name === 'rerun-from');
            if (rerunFromEntry) {
                if (String(rerunFromEntry.value).toLowerCase() !== 'dataset') {
                    logger.info(`[SPLIT-MERGE] Forcing rerun-from back to dataset (previously ${rerunFromEntry.value})`);
                }
                rerunFromEntry.value = 'dataset';
            } else {
                logger.warn(`[SPLIT-MERGE] Auto rerun-from flag removed by limits logic, re-inserting dataset value`);
                odmOptions.push({ name: 'rerun-from', value: 'dataset' });
            }
        }

        return odmOptions;
    },

    process: async function(req, res, cloudProvider, uuid, params, token, limits, getLimitedOptions){
        const ctx = await module.exports.createContext(req, res);
        const tmpPath = ctx.tmpPath;
        const appendCurlLog = ctx.appendCurlLog || (() => {});
        let { options, taskName, skipPostProcessing, outputs, dateCreated, fileNames, imagesCount, webhook } = params;
        if (!Array.isArray(fileNames)) fileNames = [];
        const isSplitSeedTask = fileNames.some(name => typeof name === 'string' && name.toLowerCase() === 'seed.zip');

        const logSeed = (message, level = 'info') => {
            if (!isSplitSeedTask) return;
            const line = `[SPLIT-MERGE][${uuid}] ${message}`;
            splitLogger.append(line);
            if (typeof logger[level] === 'function') {
                logger[level](line);
            } else {
                logger.info(line);
            }
        };

        const waitForNodeSlot = async (nodeObj, taskId) => {
            const MAX_WAIT_MS = 30 * 60 * 1000;
            const POLL_INTERVAL_MS = 5000;
            const start = Date.now();

            while (nodeObj && nodeObj.availableSlots() === 0) {
                if ((Date.now() - start) > MAX_WAIT_MS) {
                    throw new Error(`[SPLIT-MERGE] Timeout waiting for available slot on ${nodeObj} for task ${taskId}`);
                }
                const queueCount = nodeObj.getInfoProperty('taskQueueCount', 0);
                const maxParallel = nodeObj.getInfoProperty('maxParallelTasks', 0);
                logger.info(`[SPLIT-MERGE][${taskId}] Waiting for slot on ${nodeObj} (queue=${queueCount}/${maxParallel})`);
                if (isSplitSeedTask) {
                    logSeed(`Waiting for slot on ${nodeObj} (queue=${queueCount}/${maxParallel})`);
                }
                await utils.sleep(POLL_INTERVAL_MS);
                try {
                    await nodeObj.updateInfo();
                } catch (err) {
                    logger.warn(`[SPLIT-MERGE] Failed to refresh ${nodeObj}: ${err.message}`);
                }
                const refreshedQueue = nodeObj.getInfoProperty('taskQueueCount', queueCount);
                const refreshedMax = nodeObj.getInfoProperty('maxParallelTasks', maxParallel);
                logger.debug(`[SPLIT-MERGE][${taskId}] Post-refresh ${nodeObj}: queue=${refreshedQueue}/${refreshedMax}`);
            }
            if (nodeObj) {
                logger.info(`[SPLIT-MERGE][${taskId}] Slot available on ${nodeObj}, resuming upload`);
                if (isSplitSeedTask) logSeed(`Slot available on ${nodeObj}, resuming upload`);
            }
        };

        if (isSplitSeedTask) {
            logSeed(`Seed task detected with ${fileNames.length} files`);
        }
        const pathImport = params.import_path || null;
        logger.info(`[SPLIT-MERGE DEBUG][${uuid}] intake uuid=${uuid} pathImport=${pathImport || ""} fileNames=${fileNames.length} imagesCount=${imagesCount} tmpPath=${tmpPath}`);
        let importPathAvailable = false;
        if (pathImport) {
            importPathAvailable = await waitForImportPathAvailable(pathImport, logSeed);
            try {
                const importStats = fs.statSync(pathImport);
                const importEntries = importStats.isDirectory() ? fs.readdirSync(pathImport).slice(0, 20) : [];
                logger.info(`[SPLIT-MERGE DEBUG][${uuid}] import_path stat type=${importStats.isDirectory() ? "dir" : "file"} size=${importStats.size} mtime=${importStats.mtime.toISOString()} entries=${importEntries.join(",")}`);
            } catch (err) {
                logger.warn(`[SPLIT-MERGE DEBUG][${uuid}] import_path stat failed for ${pathImport}: ${err.message}`);
            }
        }

        if (fileNames.some(name => typeof name === 'string' && name.toLowerCase() === 'seed.zip')) {
            logger.warn(`[SPLIT-MERGE DEBUG][${uuid}] seed.zip upload path reached for uuid=${uuid}; pathImport=${pathImport || ""}`);
            const seedPath = path.join(tmpPath, 'seed.zip');
            const stable = await waitForStableFile(seedPath, logSeed, {
                label: `seed.zip for ${uuid}`,
                maxWaitMs: 120000,
                intervalMs: 1000,
                requiredStableChecks: 8
            });
            if (!stable) {
                throw new Error(`seed.zip did not stabilize in time for task ${uuid}`);
            }
            await logSeedZipDiagnostics(seedPath, uuid, logSeed);
            const integrity = await ensureSeedZipIntegrity(seedPath, tmpPath, uuid, logSeed);
            if (!integrity.ok) {
                throw new Error(`seed.zip failed integrity check; ${integrity.message || 'repair failed'}`);
            }
        }
        
        // Initialize global directory tracking if not exists
        if (!global.taskProcessingDirs) {
            global.taskProcessingDirs = new Set();
        }
        
        // Mark this directory as being processed to prevent file cleanup
        global.taskProcessingDirs.add(tmpPath);
        logger.info(`[TAPIS DEBUG] Marked directory ${tmpPath} as processing, total processing dirs: ${global.taskProcessingDirs.size}`);
        
        // Fix imagesCount - use actual fileNames array length instead of the potentially incorrect counter
        if (!pathImport && fileNames && Array.isArray(fileNames)) {
            imagesCount = fileNames.length;
            logger.info(`[TAPIS DEBUG] Fixed imagesCount from ${params.imagesCount} to ${imagesCount} based on fileNames array`);
        } else if (pathImport) {
            if (importPathAvailable || fs.existsSync(pathImport)) {
                try {
                    const counted = await countImagesForImportPath(pathImport);
                    if (counted > 0) {
                        logger.info(`[TAPIS DEBUG] Counted ${counted} images from import_path ${pathImport}`);
                        imagesCount = counted;
                    } else {
                        logger.warn(`[TAPIS DEBUG] Could not determine image count from import_path ${pathImport}; falling back to provided value ${imagesCount}`);
                    }
                } catch (err) {
                    logger.warn(`[TAPIS DEBUG] Failed to count images for import_path ${pathImport}: ${err.message}`);
                }
            } else {
                logger.info(`[TAPIS DEBUG] import_path not accessible on ClusterODM host, skipping image count: ${pathImport}`);
            }
        }

        if (pathImport) {
            const duplicateTask = await findMatchingPendingTask({
                token,
                importPath: pathImport,
                taskName,
                requestedOptions: options
            });

            if (duplicateTask && duplicateTask.uuid) {
                logger.warn(`[TAPIS DEBUG] Reusing existing task ${duplicateTask.uuid} for duplicate import_path submission ${uuid} (source=${duplicateTask.source}, import_path=${pathImport})`);
                if (global.taskProcessingDirs) {
                    global.taskProcessingDirs.delete(tmpPath);
                }
                try {
                    utils.rmdir(tmpPath);
                } catch (e) {
                    logger.warn(`[TAPIS DEBUG] Failed to clean duplicate tmpPath ${tmpPath}: ${e.message}`);
                }
                utils.json(res, { uuid: duplicateTask.uuid, deduped: true });
                return;
            }
        }

        // Register task in tasktable early — before the node-finding retry loop,
        // which can take 60+ seconds (12 attempts × 5s). Without this, a second
        // submission arriving during the retry loop would bypass the deduplication
        // check above because findMatchingPendingTask can't find the first task.
        // This entry will be overwritten with full taskInfo at tasktable.add below.
        const earlyName = taskName || "Task";
        await tasktable.add(uuid, {
            taskInfo: {
                uuid,
                name: earlyName,
                dateCreated: Date.now(),
                status: { code: statusCodes.RUNNING },
                options: Array.isArray(options) ? options : [],
                imagesCount: imagesCount
            },
            importPath: pathImport
        }, token);
        logger.info(`[TAPIS DEBUG] Early tasktable registration for deduplication: ${uuid}`);

        logger.info(`[TAPIS DEBUG] Starting task processing for UUID: ${uuid}`);
        
        // Debug: Check if files still exist at the very start of task processing (skip for path-based tasks)
        if (!pathImport) {
            try {
                const fs = require('fs');
                const filesAtProcessStart = fs.readdirSync(tmpPath);
                logger.info(`[TAPIS DEBUG] Files in tmpPath at START of task processing: ${filesAtProcessStart.join(', ')}`);
            } catch (e) {
                logger.error(`[TAPIS DEBUG] Cannot read tmpPath at START of task processing: ${e.message}`);
            }
        }
        
        logger.info(`[TAPIS DEBUG] fileNames: ${JSON.stringify(fileNames)}, imagesCount: ${imagesCount}`);
        logger.info(`[TAPIS DEBUG] taskName: ${taskName}, token: ${token ? 'present' : 'missing'}`);

        // If this is a path-based task, skip the file count check
        if (!pathImport && fileNames.length < 1){
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

        let node = await nodes.findBestAvailableNodeWithRetry(imagesCount, true, {
            taskId: uuid,
            logFn: isSplitSeedTask ? logSeed : null,
            retryWhenNoNodes: !!pathImport
        });
        if (isSplitSeedTask) {
            logSeed(`Best available node selected: ${node ? node.toString() : 'none'}`);
        }
        
        // Do we need to / can we create a new node via autoscaling?
        const autoscaleImagesCount = imagesCount > 0 ? imagesCount : fileNames.length;
        const autoscale = (!node || node.availableSlots() === 0) && 
                            asrProvider.isAllowedToCreateNewNodes() &&
                            asrProvider.canHandle(autoscaleImagesCount);
        
        logger.info(`[TAPIS DEBUG] Autoscale decision: ${autoscale}, node: ${node ? 'exists' : 'null'}`);
        logger.info(`[TAPIS DEBUG] ASR canCreateNodes: ${asrProvider.isAllowedToCreateNewNodes()}, canHandle: ${asrProvider.canHandle(autoscaleImagesCount)}`);
        
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
            let taskOptions = odmOptions.filterOptions(this.augmentTaskOptions(req, options, limits, token, imagesCount),
                                                        await getLimitedOptions(token, limits, node));

            const provider = asrProvider.get();
            const effectiveTapisQueue = provider && typeof provider.getEffectiveQueue === 'function'
                ? provider.getEffectiveQueue(taskOptions, imagesCount)
                : null;
            const nodeTaskOptions = tapisTaskOptions.applyGpuQueuePolicy(taskOptions, effectiveTapisQueue);

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
            eventEmitter.on('close', () => {
                ctx.closeCurlLogs();
            });

            const curlInstance = (done, onError, url, body, validate) => {
                // We use CURL, because NodeJS libraries are buggy
                const curl = new Curl(),
                      close = curl.close.bind(curl);
                const startedAt = Date.now();
                const describeBody = (parts = []) => {
                    return parts.map(part => {
                        if (part && part.file) return `file:${path.basename(part.file)}`;
                        if (part && part.name) return `field:${part.name}`;
                        return 'part';
                    }).join(', ');
                };
                
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

                            appendCurlLog(`RESPONSE status=${statusCode} url=${url} duration=${Date.now() - startedAt}ms`);
                            done();
                        }else{
                            appendCurlLog(`RESPONSE status=${statusCode} url=${url} duration=${Date.now() - startedAt}ms body=${body}`);
                            throw new Error(`POST ${url} statusCode is ${statusCode}, expected 200`);
                        }
                    }catch(e){
                        onError(e);
                    }
                });

                curl.on('error', (err) => {
                    appendCurlLog(`ERROR url=${url} duration=${Date.now() - startedAt}ms message=${err.message}`);
                    onError(err);
                });

                appendCurlLog(`REQUEST url=${url} parts=[${describeBody(body)}]`);

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

            // If the request included an import_path (shared filesystem), capture it
            const pathImport = params.import_path || null;

            // Helper to forward a path-based task to a node (no file upload)
            // Use axios + form-data (non-blocking) instead of node-libcurl to avoid potential event-loop blocking
            const axios = require('axios');
            const FormData = require('form-data');
            const forwardPathToNode = async (nodeObj, translatedPath) => {
                const form = new FormData();
                form.append('name', name);
                form.append('options', JSON.stringify(nodeTaskOptions));
                form.append('import_path', translatedPath);
                form.append('dateCreated', dateC.getTime().toString());
                if (skipPostProcessing){
                    form.append('skipPostProcessing', 'true');
                }
                if (webhook){
                    form.append('webhook', webhook);
                }
                if (outputs){
                    logger.info(`[TAPIS DEBUG] Forwarding outputs for path-based task ${uuid} (${name}) to node ${nodeObj}: ${outputs}`);
                    form.append('outputs', outputs);
                }

                const token = nodeObj.getToken ? nodeObj.getToken() : null;
                const nodeUrl = `${nodeObj.proxyTargetUrl()}/task/new${token ? `?token=${token}` : ''}`;
                
                // Timeout reasonably short so we don't block for minutes
                const timeoutMs = 60 * 1000; // 60s

                const resp = await axios.post(nodeUrl, form, {
                    headers: Object.assign({}, form.getHeaders(), {
                        'set-uuid': uuid
                    }),
                    maxBodyLength: Infinity,
                    timeout: timeoutMs
                });

                return parseNodeTaskResponse(resp);
            };

            const taskNewInit = async () => {
                if (isSplitSeedTask) logSeed(`Calling /task/new/init on ${node}`);
                return new Promise((resolve, reject) => {
                    const body = [];
                    body.push({
                        name: 'name',
                        contents: name
                    });
                    body.push({
                        name: 'options',
                        contents: JSON.stringify(nodeTaskOptions)
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
                        logger.info(`[TAPIS DEBUG] Forwarding outputs for task ${uuid} (${name}) to node ${node}: ${outputs}`);
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
                if (isSplitSeedTask) logSeed(`Uploading chunks to ${node}`);
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
                if (isSplitSeedTask) logSeed(`Committing task on ${node}`);
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
                    if (isSplitSeedTask) {
                        logSeed(`Preserving ${tmpPath} after error (cleanupTemporaryDirectory will handle it)`);
                    }
                    if (!maybePreserveTmp(tmpPath, isSplitSeedTask)) {
                        utils.rmdir(tmpPath);
                    }
                }
                
                eventEmitter.emit('close');
            };

            const doUpload = async () => {
                const MAX_UPLOAD_RETRIES = 5;
                eventEmitter.emit('close');

                // If this task was submitted with an import_path, attempt to translate and forward it
                if (pathImport) {
                    try {
                        const translated = translateImportPathForNode(pathImport, node.nodeData && node.nodeData.hostname ? node.nodeData.hostname : (node.hostname || null));
                        if (translated) {
                            logger.info(`[TAPIS DEBUG] Forwarding path-based task ${uuid} to node ${node} using import_path ${translated}`);
                            if (isSplitSeedTask) logSeed(`Forwarding via import_path ${translated} to ${node}`);
                            await forwardPathToNode(node, translated);

                            // Register routing and cleanup similar to upload flow
                            await routetable.add(uuid, node, token);
                            await tasktable.delete(uuid);
                            if (!maybePreserveTmp(tmpPath, isSplitSeedTask)) {
                                try { utils.rmdir(tmpPath); } catch(e){}
                            }

                            if (global.taskProcessingDirs) {
                                global.taskProcessingDirs.delete(tmpPath);
                                logger.info(`[TAPIS DEBUG] Removed directory ${tmpPath} from processing after path-forward, remaining dirs: ${global.taskProcessingDirs.size}`);
                            }

                            return;
                        } else {
                            logger.warn(`[TAPIS DEBUG] No mapping found for import_path ${pathImport} on node ${node}, falling back to upload`);
                            if (isSplitSeedTask) logSeed(`No mapping for import_path ${pathImport}, using upload path`);
                        }
                    } catch (e) {
                        logger.error(`[TAPIS DEBUG] Failed forwarding path-based task to node ${node}: ${e.message}`);
                        if (isSplitSeedTask) logSeed(`Import_path forwarding failed: ${e.message}`);
                        // Allow fallback to upload below (the outer retry logic will handle failures)
                    }
                }

                try{
                    if (!autoscale) node.incTransients();
                    await taskNewInit();
                    await taskNewUpload();
                    await taskNewCommit();
                    if (!autoscale) node.decTransients();
                }catch(e){
                    if (!autoscale) node.decTransients();

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
            await tasktable.add(uuid, { taskInfo, abort: abortTask, output: ["Launching... please wait! This can take a few minutes."], importPath: pathImport }, token);

            // Send back response to user right away
            utils.json(res, { uuid });

            if (autoscale){
                logger.info(`[TAPIS DEBUG] Attempting autoscale node creation`);
                const asr = asrProvider.get();
                try{
                    dmHostname = asr.generateHostname(imagesCount);
                    logger.info(`[TAPIS DEBUG] Generated hostname: ${dmHostname}, calling asr.createNode`);
                    node = await asr.createNode(req, imagesCount, token, dmHostname, status, taskOptions, fileNames, tmpPath, uuid, pathImport);
                    logger.info(`[TAPIS DEBUG] Node created successfully: ${node ? node.constructor.name : 'null'}`);
                    
                    // Debug: Check if files still exist after node creation
                    try {
                        const fs = require('fs');
                        const filesAfterNodeCreation = fs.readdirSync(tmpPath);
                        logger.info(`[TAPIS DEBUG] Files in tmpPath AFTER node creation: ${filesAfterNodeCreation.join(', ')}`);
                    } catch (e) {
                        logger.error(`[TAPIS DEBUG] Cannot read tmpPath AFTER node creation: ${e.message}`);
                    }
                    
                    if (!status.aborted && node) {
                        nodes.add(node);
                        logger.info(`[TAPIS DEBUG] Added node to cluster, total nodes: ${nodes.all().length}`);
                    } else if (!node) {
                        logger.info(`[TAPIS DEBUG] No node returned from createNode - task stored as pending, waiting for NodeODM registration`);
                        logger.info(`[TAPIS DEBUG] Task submission completed - no immediate processing needed`);
                        // Task will be handled when NodeODM registers
                        // Response already sent with utils.json(res, { uuid }) above, just return
                        return;
                    } else return;
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
                    if (isSplitSeedTask) logSeed(`Submitting to TAPIS node ${node}`);
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
                    if (!autoscale && node.availableSlots() === 0) {
                        logSeed(`Node ${node} full, waiting before upload`);
                        await waitForNodeSlot(node, uuid);
                    }
                    if (isSplitSeedTask) logSeed(`Starting upload to node ${node}`);
                    // Regular node processing
                    await doUpload();
                    eventEmitter.emit('close');

                    await routetable.add(uuid, node, token);
                    await tasktable.delete(uuid);

                    const logTmp = (message, level = 'info') => {
                        if (isSplitSeedTask) {
                            logSeed(message, level);
                        } else if (typeof logger[level] === 'function') {
                            logger[level](`[TASK ${uuid}] ${message}`);
                        } else {
                            logger.info(`[TASK ${uuid}] ${message}`);
                        }
                    };

                    try {
                        const tmpEntries = fs.existsSync(tmpPath) ? fs.readdirSync(tmpPath) : [];
                        logTmp(`Upload complete, tmpPath contains: ${tmpEntries.length ? tmpEntries.join(', ') : '[empty]'}`);
                    } catch (listErr) {
                        logTmp(`Could not list ${tmpPath} before cleanup: ${listErr.message}`, 'warn');
                    }

                    const preserved = maybePreserveTmp(tmpPath, isSplitSeedTask, logTmp);
                    if (!preserved) {
                        utils.rmdir(tmpPath);
                    }

                    if (isSplitSeedTask) logSeed(`Routing established to node ${node}`);
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
    },

    // Export helper for testing
    translateImportPathForNode: translateImportPathForNode,
    parseNodeTaskResponse: parseNodeTaskResponse
};
