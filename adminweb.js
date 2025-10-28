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
const logger = require("./libs/logger");
const express = require("express");
const basicAuth = require("express-basic-auth");
const nodes = require("./libs/nodes");
const package_info = require("./package_info");
const cors = require("cors");
const netutils = require("./libs/netutils");
const asrProvider = require("./libs/asrProvider");

module.exports = {
  create: function (options) {
    logger.info("Starting admin web interface on " + options.port);

    const app = express();
    app.use(express.json());
    app.use(cors());

    app.get("/signout", (req, res) => {
      res.status(401).send('Signed out. <br /> <a href="/">Sign back in</a>');
    });

    if (!options.password) {
      logger.warn(`No admin password specified, make sure port ${options.port} is secured`);
    } else {
      app.use(
        basicAuth({
          users: { admin: options.password },
          challenge: true,
          realm: "ClusterODM",
        })
      );
    }

    app.use(express.static("public"));
    app.use(express.json());

    // API
    app.get("/r/info", (req, res) => {
      const { name, version } = package_info;
      res.json({ name, version });
    });

    app.get("/r/node/list", (req, res) => {
      const list = nodes.all();
      res.json(list.map((node) => nodeToJson(node)));
    });

    app.delete("/r/node", async (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = await netutils.removeAndCleanupNode(nodes.nth(number), asrProvider.get());
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/unlock", (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = nodes.unlock(nodes.nth(number));
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/lock", (req, res) => {
      const { number } = req.body;
      if (number) {
        const isSuccess = nodes.lock(nodes.nth(number));
        res.status(200).json(isSuccess);
      } else {
        res.status(403).send();
      }
    });

    app.post("/r/node/add", (req, res) => {
      const { hostname, port, token } = req.body;
      const node = nodes.addUnique(hostname, port, token);

      if (node) {
        node.updateInfo();
        res.send({ success: true });
      } else {
        res.send({ error: "Invalid" });
      }
    });

    app.post("/webhook/register-node", async (req, res) => {
      const { hostname, port, token, registrationSecret, tapisToken, registrationUuid, tapisJobUuid, nodeReady, tapisJobOwner } = req.body;

      // Extract Tapis JWT token from Authorization header (Bearer token)
      let authHeaderToken = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        authHeaderToken = authHeader.substring(7); // Remove "Bearer " prefix
        logger.info(`Extracted Tapis JWT token from Authorization header`);
      }

      // Use token from header if available, otherwise fall back to body
      const effectiveTapisToken = authHeaderToken || tapisToken;

      // Validate required fields
      if (!hostname || !port) {
        return res.status(400).json({ error: "Missing hostname or port" });
      }

      logger.info(`Node registration request from ${hostname}:${port}`);
      logger.info(`[TAPIS DEBUG] Registration payload: ${JSON.stringify(req.body)}`);

      // Authentication validation
      let authenticated = false;

      // Method 1: UUID-based authentication (simple and reliable for Tapis jobs)
      if (registrationUuid) {
        // Simple UUID validation - check if it's a valid UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(registrationUuid)) {
          logger.info(`UUID authentication successful for node ${hostname}:${port} (UUID: ${registrationUuid})`);
          authenticated = true;
        } else {
          logger.warn(`Invalid UUID format for node ${hostname}:${port}: ${registrationUuid}`);
          return res.status(401).json({ error: "Invalid UUID format" });
        }
      }

      // Method 2: Tapis User ID authentication (simple and reliable)
      else if (tapisJobOwner) {
        logger.info(`Using Tapis User ID authentication for node ${hostname}:${port} (user: ${tapisJobOwner})`);
        authenticated = true;
      }

      // Method 3: Tapis JWT token authentication (fallback for compatibility)
      else if (effectiveTapisToken) {
        try {
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();

          if (provider && provider.getDriverName && provider.getDriverName() === 'tapis') {
            logger.info(`Validating Tapis JWT token for node ${hostname}:${port}`);
            await provider.validateToken(effectiveTapisToken);
            authenticated = true;
            logger.info(`Tapis JWT token validation successful for ${hostname}:${port}`);
          } else {
            logger.warn(`Tapis token provided but no Tapis ASR provider available`);
            return res.status(400).json({ error: "Tapis token provided but Tapis provider not configured" });
          }
        } catch (e) {
          logger.warn(`Tapis JWT token validation failed for ${hostname}:${port}: ${e.message}`);
          return res.status(401).json({ error: `Tapis token validation failed: ${e.message}` });
        }
      }

      // Method 2: Registration secret authentication (fallback)
      if (!authenticated && options.registrationSecret) {
        if (registrationSecret !== options.registrationSecret) {
          logger.warn(`Invalid registration secret from ${hostname}:${port}`);
          return res.status(401).json({ error: "Invalid registration secret" });
        }
        authenticated = true;
        logger.info(`Registration secret validation successful for ${hostname}:${port}`);
      }

      // Method 3: No authentication required (if no secret configured)
      if (!authenticated && !options.registrationSecret) {
        authenticated = true;
        logger.info(`No authentication required for ${hostname}:${port}`);
      }

      // If authentication is required but not provided
      if (!authenticated) {
        logger.warn(`Authentication required but not provided for ${hostname}:${port}`);
        return res.status(401).json({
          error: "Authentication required: provide 'registrationUuid', 'tapisToken', or 'registrationSecret'"
        });
      }

      // Check if this is a Tapis node that was pre-created and needs data transfer
      let tapisNode = null;
      let registeredNodeUser = null;

      // Extract user information - prefer job owner, fall back to JWT token
      if (tapisJobOwner) {
        // Simple user ID authentication
        registeredNodeUser = {
          username: tapisJobOwner,
          tenantId: 'portals', // Default tenant for TACC
          fullUser: `${tapisJobOwner}@portals`
        };
        logger.info(`Using Tapis job owner for user matching: ${registeredNodeUser.fullUser}`);
      } else if (effectiveTapisToken) {
        // JWT token authentication (fallback)
        try {
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();
          if (provider && provider.extractUserFromToken) {
            registeredNodeUser = provider.extractUserFromToken(effectiveTapisToken);
            logger.info(`Extracted user from Tapis token: ${registeredNodeUser ? registeredNodeUser.fullUser : 'none'}`);
          }
        } catch (e) {
          logger.warn(`Failed to extract user from Tapis token: ${e.message}`);
        }
      }

      if (tapisJobUuid && nodeReady) {
        logger.info(`Looking for pre-created TapisNode with job UUID: ${tapisJobUuid}`);

        // Find the TapisNode that matches this Tapis job
        const TapisNode = require('./libs/classes/TapisNode');
        const allNodes = nodes.all();

        for (let existingNode of allNodes) {
          if (existingNode instanceof TapisNode && existingNode.tapisJobId === tapisJobUuid) {
            tapisNode = existingNode;
            logger.info(`Found matching TapisNode: ${tapisNode.jobId} (Tapis job: ${tapisNode.tapisJobId})`);
            break;
          }
        }

        // If no exact UUID match, look for any node owned by the same user
        if (!tapisNode && registeredNodeUser) {
          logger.info(`No exact UUID match found, looking for node owned by user: ${registeredNodeUser.fullUser}`);

          for (let existingNode of allNodes) {
            if (existingNode instanceof TapisNode &&
                existingNode.waitingForRegistration &&
                existingNode.nodeUser === registeredNodeUser.fullUser) {
              tapisNode = existingNode;
              logger.info(`Found TapisNode owned by same user: ${tapisNode.jobId} (user: ${existingNode.nodeUser})`);
              break;
            }
          }
        }

        if (tapisNode) {
          // Replace placeholder with real node data
          try {
            logger.info(`Replacing placeholder TapisNode with real NodeODM ${hostname}:${port}`);

            // Update the placeholder with real node details
            tapisNode.hostname = hostname;
            tapisNode.port = port;
            tapisNode.token = token;
            tapisNode.nodeRegistered = true;
            tapisNode.waitingForRegistration = false;

            // Submit the pending task to the real NodeODM
            if (tapisNode.pendingTaskData) {
              setTimeout(async () => {
                try {
                  const FormData = require('form-data');
                  const fs = require('fs');
                  const path = require('path');
                  const axios = require('axios');

                  const { taskOptions, fileNames, tmpPath } = tapisNode.pendingTaskData;

                  const form = new FormData();
                  form.append('name', `tapis_job_${tapisNode.jobId}`);

                  // Add processing options
                  for (const [key, value] of Object.entries(taskOptions)) {
                    form.append(key, value);
                  }

                  // Add image files
                  if (fileNames && tmpPath) {
                    for (const fileName of fileNames) {
                      const filePath = path.join(tmpPath, fileName);
                      if (fs.existsSync(filePath)) {
                        form.append('images', fs.createReadStream(filePath));
                      }
                    }
                  }

                  const nodeUrl = `http://${hostname}:${port}`;
                  const tokenParam = token ? `?token=${token}` : '';

                  logger.info(`[TAPIS DEBUG] Submitting pending task to registered NodeODM ${nodeUrl}/task/new`);

                  const response = await axios.post(`${nodeUrl}/task/new${tokenParam}`, form, {
                    headers: {
                      ...form.getHeaders()
                    },
                    timeout: 300000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                  });

                  logger.info(`[TAPIS DEBUG] NodeODM response:`, JSON.stringify(response.data, null, 2));

                  const taskUuid = response.data?.uuid;
                  if (!taskUuid) {
                    logger.error(`[TAPIS DEBUG] No task UUID in response. Response structure:`, JSON.stringify(response.data, null, 2));
                    throw new Error('NodeODM response missing task UUID');
                  }

                  tapisNode.currentTask = taskUuid;
                  logger.info(`[TAPIS DEBUG] Successfully created task ${taskUuid} on registered NodeODM`);

                  // Clean up pending data and tmp files
                  tapisNode.pendingTaskData = null;
                  if (tmpPath) {
                    try {
                      const utils = require('./libs/utils');
                      utils.rmdir(tmpPath);
                      logger.info(`[TAPIS DEBUG] Cleaned up tmp directory: ${tmpPath}`);
                    } catch (e) {
                      logger.warn(`Could not clean up tmp directory: ${e.message}`);
                    }
                  }

                } catch (e) {
                  logger.error(`Failed to submit pending task to registered NodeODM: ${e.message}`);
                }
              }, 2000);
            }

            res.json({
              success: true,
              message: "Tapis placeholder node updated with real NodeODM",
              nodeId: nodes.all().indexOf(tapisNode) + 1,
              tapisJobUuid: tapisJobUuid,
              authMethod: registrationUuid ? "uuid" : (tapisJobOwner ? "tapis-user-id" : (effectiveTapisToken ? "tapis-jwt" : "registration-secret"))
            });
            return;
          } catch (e) {
            logger.error(`Failed to update placeholder TapisNode ${tapisJobUuid}: ${e.message}`);
            res.status(500).json({
              success: false,
              error: `Failed to update placeholder node: ${e.message}`
            });
            return;
          }
        } else {
          logger.warn(`No matching TapisNode found for job UUID: ${tapisJobUuid}`);

          // Check for pending tasks in the Tapis provider
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();

          logger.info(`[TAPIS DEBUG] pendingTasks keys at registration: ${provider && provider.pendingTasks ? Array.from(provider.pendingTasks.keys()).join(', ') : 'none'}`);
          logger.info(`[TAPIS DEBUG] registrationUuid provided: ${registrationUuid || 'none'}, registeredNodeUser: ${registeredNodeUser ? registeredNodeUser.fullUser : 'none'}`);

          logger.info(`[TAPIS DEBUG] Checking for pending tasks - provider exists: ${!!provider}`);
          logger.info(`[TAPIS DEBUG] Provider has pendingTasks: ${!!(provider && provider.pendingTasks)}`);
          logger.info(`[TAPIS DEBUG] Pending tasks count: ${provider && provider.pendingTasks ? provider.pendingTasks.size : 'N/A'}`);
          logger.info(`[TAPIS DEBUG] Looking for tapisJobUuid: ${tapisJobUuid}`);

          if (provider && provider.pendingTasks) {
            logger.info(`[TAPIS DEBUG] All pending task UUIDs: ${Array.from(provider.pendingTasks.keys()).join(', ')}`);
          }

          // First try to find exact UUID match
          let pendingTask = null;
          if (provider && provider.pendingTasks && provider.pendingTasks.has(tapisJobUuid)) {
            pendingTask = provider.pendingTasks.get(tapisJobUuid);
            logger.info(`[TAPIS DEBUG] Found pending task for exact Tapis job UUID: ${tapisJobUuid}`);
          }

          // If no exact match and we have user info, look for any task from the same user
          if (!pendingTask && registeredNodeUser && provider && provider.pendingTasks) {
            logger.info(`[TAPIS DEBUG] No exact UUID match, looking for pending task from user: ${registeredNodeUser.fullUser}`);

            for (const [jobUuid, task] of provider.pendingTasks) {
              if (task.nodeUser === registeredNodeUser.fullUser) {
                pendingTask = task;
                logger.info(`[TAPIS DEBUG] Found pending task from same user: ${jobUuid} (user: ${task.nodeUser})`);
                // Remove from original key and add to current UUID for consistency
                provider.pendingTasks.delete(jobUuid);
                provider.pendingTasks.set(tapisJobUuid, pendingTask);
                break;
              }
            }
          }

          // If still no match, try matching by registration UUID prefix/suffix
          if (!pendingTask && registrationUuid && provider && provider.pendingTasks) {
            logger.info(`[TAPIS DEBUG] No user match, attempting registration UUID match: ${registrationUuid}`);
            for (const [jobUuid, task] of provider.pendingTasks) {
              if (typeof jobUuid === 'string' &&
                  (jobUuid.startsWith(registrationUuid) || registrationUuid.startsWith(jobUuid))) {
                pendingTask = task;
                logger.info(`[TAPIS DEBUG] Matched pending task using registration UUID heuristic: ${jobUuid}`);
                provider.pendingTasks.delete(jobUuid);
                provider.pendingTasks.set(tapisJobUuid || jobUuid, pendingTask);
                break;
              }
            }
          }

          if (pendingTask) {
            logger.info(`[TAPIS DEBUG] Processing pending task, creating task now`);
            logger.info(`[TAPIS DEBUG] Pending task data: ${JSON.stringify(Object.keys(pendingTask))}`);

            // Register the node first
            const node = nodes.addUnique(hostname, port, token);
            if (node) {
              logger.info(`Registered NodeODM ${hostname}:${port} for pending Tapis task`);

              // Create and submit the task to this real node
              setTimeout(async () => {
                try {
                  const FormData = require('form-data');
                  const fs = require('fs');
                  const path = require('path');
                  const axios = require('axios');

                  const form = new FormData();
                  form.append('name', `tapis_job_${pendingTask.jobId}`);

                  // Add processing options
                  if (pendingTask.taskOptions && typeof pendingTask.taskOptions === 'object') {
                    for (const [key, value] of Object.entries(pendingTask.taskOptions)) {
                      form.append(key, value);
                    }
                  } else {
                    logger.warn(`[TAPIS DEBUG] taskOptions is missing or invalid: ${pendingTask.taskOptions}`);
                  }

                  // Add image files if available
                  if (pendingTask.fileNames && pendingTask.tmpPath) {
                    for (const fileName of pendingTask.fileNames) {
                      const filePath = path.join(pendingTask.tmpPath, fileName);
                      if (fs.existsSync(filePath)) {
                        form.append('images', fs.createReadStream(filePath));
                      }
                    }
                  }

                  const nodeUrl = `http://${hostname}:${port}`;
                  const tokenParam = token ? `?token=${token}` : '';

                  logger.info(`[TAPIS DEBUG] Submitting task to registered NodeODM ${nodeUrl}/task/new`);

                  const response = await axios.post(`${nodeUrl}/task/new${tokenParam}`, form, {
                    headers: {
                      ...form.getHeaders()
                    },
                    timeout: 300000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                  });

                  logger.info(`[TAPIS DEBUG] NodeODM response:`, JSON.stringify(response.data, null, 2));

                  const taskUuid = response.data?.uuid;
                  if (!taskUuid) {
                    logger.error(`[TAPIS DEBUG] No task UUID in response. Response structure:`, JSON.stringify(response.data, null, 2));
                    throw new Error('NodeODM response missing task UUID');
                  }

                  logger.info(`[TAPIS DEBUG] Successfully created task ${taskUuid} on NodeODM for Tapis job ${tapisJobUuid}`);

                  // Clean up tmp directory and protection lock
                  if (pendingTask.tmpPath) {
                    try {
                      const fs = require('fs');
                      const lockFile = pendingTask.tmpPath + '/.tapis_pending_task';
                      if (fs.existsSync(lockFile)) {
                        fs.unlinkSync(lockFile);
                      }

                      const utils = require('./libs/utils');
                      utils.rmdir(pendingTask.tmpPath);
                      logger.info(`[TAPIS DEBUG] Cleaned up tmp directory: ${pendingTask.tmpPath}`);
                    } catch (e) {
                      logger.warn(`Could not clean up tmp directory: ${e.message}`);
                    }
                  }

                  // Remove from pending tasks
                  provider.pendingTasks.delete(tapisJobUuid);

                } catch (e) {
                  logger.error(`Failed to submit task to registered NodeODM: ${e.message}`);
                }
              }, 2000); // Give the node time to fully start

              res.json({
                success: true,
                message: "NodeODM registered and task submitted",
                nodeId: nodes.all().indexOf(node) + 1,
                tapisJobUuid: tapisJobUuid,
                authMethod: registrationUuid ? "uuid" : (tapisJobOwner ? "tapis-user-id" : (effectiveTapisToken ? "tapis-jwt" : "registration-secret"))
              });
              return;
            }
          }
        }
      }

      // Fall back to regular node registration if not a Tapis node or no match found
      const node = nodes.addUnique(hostname, port, token);

      if (node) {
        logger.info(`Successfully registered regular node ${hostname}:${port}`);
        node.updateInfo();
        const provider = require('./libs/asrProvider').get();
        if (provider && provider.pendingTasks) {
          logger.info(`[TAPIS DEBUG] pendingTasks still outstanding after fallback registration: ${provider.pendingTasks.size}`);
        }
        res.json({
          success: true,
          message: "Node registered successfully",
          nodeId: nodes.all().indexOf(node) + 1,
          authMethod: registrationUuid ? "uuid" : (tapisToken ? "tapis-jwt" : "registration-secret")
        });
      } else {
        logger.warn(`Node ${hostname}:${port} already exists or invalid`);
        res.json({
          success: false,
          error: "Node already exists or invalid parameters"
        });
      }
    });

    app.post("/webhook/deregister-node", async (req, res) => {
      const { hostname, port, nodeId, tapisToken, registrationSecret, registrationUuid } = req.body;

      // Extract Tapis JWT token from Authorization header (Bearer token)
      let authHeaderToken = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        authHeaderToken = authHeader.substring(7); // Remove "Bearer " prefix
        logger.info(`Extracted Tapis JWT token from Authorization header for de-registration`);
      }

      // Use token from header if available, otherwise fall back to body
      const effectiveTapisToken = authHeaderToken || tapisToken;

      logger.info(`Node de-registration request from ${hostname || 'unknown'}:${port || 'unknown'}`);

      // Authentication validation (same as registration)
      let authenticated = false;

      // Method 1: UUID-based authentication (simple and reliable for Tapis jobs)
      if (registrationUuid) {
        // Simple UUID validation - check if it's a valid UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(registrationUuid)) {
          logger.info(`UUID authentication successful for de-registration ${hostname}:${port} (UUID: ${registrationUuid})`);
          authenticated = true;
        } else {
          logger.warn(`Invalid UUID format for de-registration ${hostname}:${port}: ${registrationUuid}`);
          return res.status(401).json({ error: "Invalid UUID format" });
        }
      }

      // Method 2: Tapis JWT token authentication (fallback for compatibility)
      else if (effectiveTapisToken) {
        try {
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();

          if (provider && provider.getDriverName && provider.getDriverName() === 'tapis') {
            logger.info(`Validating Tapis JWT token for node de-registration ${hostname}:${port}`);
            await provider.validateToken(effectiveTapisToken);
            authenticated = true;
            logger.info(`Tapis JWT token validation successful for de-registration ${hostname}:${port}`);
          } else {
            logger.warn(`Tapis token provided but no Tapis ASR provider available`);
            return res.status(400).json({ error: "Tapis token provided but Tapis provider not configured" });
          }
        } catch (e) {
          logger.warn(`Tapis JWT token validation failed for de-registration ${hostname}:${port}: ${e.message}`);
          return res.status(401).json({ error: `Tapis token validation failed: ${e.message}` });
        }
      }

      // Method 2: Registration secret authentication (fallback)
      if (!authenticated && options.registrationSecret) {
        if (registrationSecret !== options.registrationSecret) {
          logger.warn(`Invalid registration secret for de-registration from ${hostname}:${port}`);
          return res.status(401).json({ error: "Invalid registration secret" });
        }
        authenticated = true;
        logger.info(`Registration secret validation successful for de-registration ${hostname}:${port}`);
      }

      // Method 3: No authentication required (if no secret configured)
      if (!authenticated && !options.registrationSecret) {
        authenticated = true;
        logger.info(`No authentication required for de-registration ${hostname}:${port}`);
      }

      // If authentication is required but not provided
      if (!authenticated) {
        logger.warn(`Authentication required but not provided for de-registration ${hostname}:${port}`);
        return res.status(401).json({
          error: "Authentication required: provide 'registrationUuid', 'tapisToken', or 'registrationSecret'"
        });
      }

      // Find node to remove
      let nodeToRemove = null;

      // Method 1: Find by nodeId (most reliable)
      if (nodeId) {
        nodeToRemove = nodes.nth(nodeId);
        if (!nodeToRemove) {
          logger.warn(`Node with ID ${nodeId} not found for de-registration`);
          return res.status(404).json({ error: `Node with ID ${nodeId} not found` });
        }
      }
      // Method 2: Find by hostname and port
      else if (hostname && port) {
        nodeToRemove = nodes.find(n => n.hostname() === hostname && n.port() === parseInt(port));
        if (!nodeToRemove) {
          logger.warn(`Node ${hostname}:${port} not found for de-registration`);
          return res.status(404).json({ error: `Node ${hostname}:${port} not found` });
        }
      }
      // Method 3: Missing identification
      else {
        logger.warn(`Insufficient information provided for de-registration: need nodeId or hostname+port`);
        return res.status(400).json({ error: "Must provide either 'nodeId' or 'hostname' and 'port'" });
      }

      // Remove the node
      const success = nodes.remove(nodeToRemove);

      if (success) {
        const nodeInfo = `${nodeToRemove.hostname()}:${nodeToRemove.port()}`;
        logger.info(`Successfully de-registered node ${nodeInfo}`);

        // If it's an auto-spawned node (like TapisNode), clean up resources
        if (nodeToRemove.isAutoSpawned && nodeToRemove.isAutoSpawned()) {
          try {
            const asrProvider = require('./libs/asrProvider');
            const provider = asrProvider.get();
            if (provider && provider.destroyNode) {
              logger.info(`Cleaning up auto-spawned node ${nodeInfo}`);
              await provider.destroyNode(nodeToRemove);
            }
          } catch (e) {
            logger.warn(`Failed to cleanup auto-spawned node ${nodeInfo}: ${e.message}`);
          }
        }

        res.json({
          success: true,
          message: "Node de-registered successfully",
          nodeInfo: nodeInfo,
          authMethod: registrationUuid ? "uuid" : (tapisToken ? "tapis-jwt" : "registration-secret")
        });
      } else {
        logger.error(`Failed to remove node ${nodeToRemove.hostname()}:${nodeToRemove.port()}`);
        res.status(500).json({
          success: false,
          error: "Failed to remove node from cluster"
        });
      }
    });

    app.listen(options.port);
  },
};

const nodeToJson = (node) => ({
  name: node.toString(),
  isLocked: node.isLocked(),
  isAutoSpawned: node.isAutoSpawned(),
  isOnline: node.isOnline(),
  getTaskQueueCount: node.getTaskQueueCount(),
  getMaxParallelTasks: node.getMaxParallelTasks(),
  getEngineInfo: node.getEngineInfo(),
  getVersion: node.getVersion(),
  nodeData: node.nodeData,
});
