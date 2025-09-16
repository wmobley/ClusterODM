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
      const { hostname, port, token, registrationSecret, tapisToken, registrationUuid, tapisJobUuid, nodeReady } = req.body;

      // Validate required fields
      if (!hostname || !port) {
        return res.status(400).json({ error: "Missing hostname or port" });
      }

      logger.info(`Node registration request from ${hostname}:${port}`);

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

      // Method 2: Tapis JWT token authentication (fallback for compatibility)
      else if (tapisToken) {
        try {
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();

          if (provider && provider.getDriverName && provider.getDriverName() === 'tapis') {
            logger.info(`Validating Tapis JWT token for node ${hostname}:${port}`);
            await provider.validateToken(tapisToken);
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

        if (tapisNode) {
          // Update the TapisNode with the real node details and trigger data transfer
          try {
            await tapisNode.onNodeRegistered(hostname, port, token);
            logger.info(`Successfully triggered data transfer for TapisNode ${tapisJobUuid}`);

            res.json({
              success: true,
              message: "Tapis node registered and data transfer initiated",
              nodeId: nodes.all().indexOf(tapisNode) + 1,
              tapisJobUuid: tapisJobUuid,
              authMethod: registrationUuid ? "uuid" : (tapisToken ? "tapis-jwt" : "registration-secret")
            });
            return;
          } catch (e) {
            logger.error(`Failed to trigger data transfer for TapisNode ${tapisJobUuid}: ${e.message}`);
            res.status(500).json({
              success: false,
              error: `Failed to trigger data transfer: ${e.message}`
            });
            return;
          }
        } else {
          logger.warn(`No matching TapisNode found for job UUID: ${tapisJobUuid}`);

          // Check for pending tasks in the Tapis provider
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();
          if (provider && provider.pendingTasks && provider.pendingTasks.has(tapisJobUuid)) {
            const pendingTask = provider.pendingTasks.get(tapisJobUuid);
            logger.info(`Found pending task for Tapis job ${tapisJobUuid}, creating task now`);

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
                  for (const [key, value] of Object.entries(pendingTask.taskOptions)) {
                    form.append(key, value);
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
                    timeout: 300000
                  });

                  logger.info(`[TAPIS DEBUG] Successfully created task ${response.data.uuid} on NodeODM for Tapis job ${tapisJobUuid}`);

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
                authMethod: registrationUuid ? "uuid" : (tapisToken ? "tapis-jwt" : "registration-secret")
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
      else if (tapisToken) {
        try {
          const asrProvider = require('./libs/asrProvider');
          const provider = asrProvider.get();

          if (provider && provider.getDriverName && provider.getDriverName() === 'tapis') {
            logger.info(`Validating Tapis JWT token for node de-registration ${hostname}:${port}`);
            await provider.validateToken(tapisToken);
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
