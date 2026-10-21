/**
 *  nodeodm-proxy - A reverse proxy, load balancer and task tracker for NodeODM
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
// Group-writable default so any data ClusterODM writes to shared storage stays g+rw
// for the allocation group (consistent with the WebODM/NodeODM corral group model).
// Overridable via the CLUSTERODM_UMASK env var.
// See docs/design/2026-07-01-corral-ownership-group-inheritance.md (odm-suite)
process.umask(process.env.CLUSTERODM_UMASK ? parseInt(process.env.CLUSTERODM_UMASK, 8) : 0o002);

const config = require('./config');
const admincli = require('./admincli');
const adminweb = require('./adminweb');
const logger = require('./libs/logger');
const package_info = require('./package_info');
const nodes = require('./libs/nodes');
const proxy = require('./libs/proxy');
const floodMonitor = require('./libs/floodMonitor');
const routetable = require('./libs/routetable');

(async function(){
    if (config.debug) logger.warn("Running in debug mode");
    logger.info(package_info.name + " " + package_info.version + " started with PID " + process.pid);
    logger.debug("Debug messages are ON");
    if (config.admin_cli_port !== 0){
        if (!config.admin_pass){
            logger.warn(`Admin CLI disabled because no password was configured (port ${config.admin_cli_port})`);
        }else{
            try {
                await admincli.create({port: config.admin_cli_port, password: config.admin_pass});
            } catch (error){
                if (error && error.code === 'EADDRINUSE'){
                    logger.error(`Unable to start admin CLI on port ${config.admin_cli_port}: address already in use. Stop the other service or choose a different --admin-cli-port.`);
                }else{
                    logger.error(`Unable to start admin CLI: ${error && error.stack ? error.stack : error}`);
                }
                process.exitCode = 1;
            }
        }
    }
    if (config.admin_web_port !== 0){
        try {
            await adminweb.create({
                port: config.admin_web_port,
                password: config.admin_pass,
                registrationSecret: config.registration_secret,
                webodm: config.webodm,
                sessionSecret: config.admin_session_secret,
                useSecureCookies: !!config.use_ssl,
                tapisJwt: {
                    enabled: config.admin_web_use_tapis_jwt,
                    allowedTenants: config.admin_web_allowed_tenants || [],
                    allowedUsers: config.admin_web_allowed_users || []
                }
            });
        } catch (error){
            logger.error(`Unable to start admin web interface on port ${config.admin_web_port}: ${error && error.code === 'EADDRINUSE' ? 'address already in use' : (error && error.message ? error.message : error)}`);
            process.exitCode = 1;
            return;
        }
    }
    const cloudProvider = (require('./libs/cloudProvider')).initialize(config.cloud_provider);
    await (require('./libs/asrProvider')).initialize(config.asr);
    await nodes.initialize();
    floodMonitor.initialize();

    const proxies = await proxy.initialize(cloudProvider);

    const gracefulShutdown = async() => {
        await nodes.cleanup();
        await routetable.cleanup();
        
        logger.info("Bye!");
        process.exit(0);
    };

    // listen for TERM signal .e.g. kill
    process.on('SIGTERM', gracefulShutdown);

    // listen for INT signal e.g. Ctrl-C
    process.on('SIGINT', gracefulShutdown);

    process.on('uncaughtException', err => {
        logger.error(`Uncaught Exception: ${err.stack}`);
    });

    // Start
    proxies.forEach(proxy => {
        // Do not start insecure server if SSL is enabled and a secure port parameter
        // is not specified (that implies we want both secure and non secure)
        if (config.use_ssl && !config.secure_port && !proxy.secure) return;

        let port = config.port;

        // If we specified a secure port, it means we need to bind the secure service
        // to this port
        if (config.use_ssl && config.secure_port && proxy.secure){
            port = config.secure_port;
        }

        logger.info(`Starting ${proxy.secure ? 'https' : 'http'} proxy on ${port}`);
        proxy.server.listen(port);
    });
})();
