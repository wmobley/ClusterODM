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
      const { hostname, port, token, registrationSecret, tapisToken } = req.body;

      // Validate required fields
      if (!hostname || !port) {
        return res.status(400).json({ error: "Missing hostname or port" });
      }

      logger.info(`Node registration request from ${hostname}:${port}`);

      // Authentication validation
      let authenticated = false;

      // Method 1: Tapis JWT token authentication (preferred for Tapis nodes)
      if (tapisToken) {
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
          error: "Authentication required: provide either 'tapisToken' or 'registrationSecret'"
        });
      }

      const node = nodes.addUnique(hostname, port, token);

      if (node) {
        logger.info(`Successfully registered node ${hostname}:${port}`);
        node.updateInfo();
        res.json({
          success: true,
          message: "Node registered successfully",
          nodeId: nodes.all().indexOf(node) + 1,
          authMethod: tapisToken ? "tapis-jwt" : "registration-secret"
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
      const { hostname, port, nodeId, tapisToken, registrationSecret } = req.body;

      logger.info(`Node de-registration request from ${hostname || 'unknown'}:${port || 'unknown'}`);

      // Authentication validation (same as registration)
      let authenticated = false;

      // Method 1: Tapis JWT token authentication (preferred for Tapis nodes)
      if (tapisToken) {
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
          error: "Authentication required: provide either 'tapisToken' or 'registrationSecret'"
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
          authMethod: tapisToken ? "tapis-jwt" : "registration-secret"
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
