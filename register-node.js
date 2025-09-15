#!/usr/bin/env node
/**
 * Node Auto-Registration Client for ClusterODM-Tapis
 *
 * This script allows compute nodes to automatically register themselves
 * with the ClusterODM cluster using a webhook endpoint, eliminating
 * the need for manual telnet registration.
 *
 * Usage:
 *   node register-node.js --cluster-host <host> --cluster-port <port> [options]
 *
 * Environment Variables:
 *   CLUSTER_HOST: ClusterODM host (alternative to --cluster-host)
 *   CLUSTER_PORT: ClusterODM port (alternative to --cluster-port)
 *   NODE_HOST: This node's hostname (alternative to --node-host)
 *   NODE_PORT: This node's port (alternative to --node-port)
 *   NODE_TOKEN: NodeODM token (alternative to --node-token)
 *   REGISTRATION_SECRET: Shared secret (alternative to --registration-secret)
 */

const axios = require('axios');
const os = require('os');

function parseArgs() {
    const args = {
        clusterHost: process.env.CLUSTER_HOST || 'localhost',
        clusterPort: process.env.CLUSTER_PORT || '10000',
        nodeHost: process.env.NODE_HOST || getLocalIP(),
        nodePort: process.env.NODE_PORT || '3000',
        nodeToken: process.env.NODE_TOKEN || '',
        registrationSecret: process.env.REGISTRATION_SECRET || '',
        tapisToken: process.env.TAPIS_TOKEN || '',
        nodeId: process.env.NODE_ID || '',
        retries: 5,
        retryDelay: 10,
        deregister: false,
        help: false
    };

    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        const nextArg = process.argv[i + 1];

        switch (arg) {
            case '--cluster-host':
                args.clusterHost = nextArg;
                i++;
                break;
            case '--cluster-port':
                args.clusterPort = nextArg;
                i++;
                break;
            case '--node-host':
                args.nodeHost = nextArg;
                i++;
                break;
            case '--node-port':
                args.nodePort = nextArg;
                i++;
                break;
            case '--node-token':
                args.nodeToken = nextArg;
                i++;
                break;
            case '--registration-secret':
                args.registrationSecret = nextArg;
                i++;
                break;
            case '--tapis-token':
                args.tapisToken = nextArg;
                i++;
                break;
            case '--node-id':
                args.nodeId = nextArg;
                i++;
                break;
            case '--retries':
                args.retries = parseInt(nextArg) || 5;
                i++;
                break;
            case '--retry-delay':
                args.retryDelay = parseInt(nextArg) || 10;
                i++;
                break;
            case '--deregister':
                args.deregister = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
        }
    }

    return args;
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            // Skip internal and IPv6 addresses
            if (!interface.internal && interface.family === 'IPv4') {
                return interface.address;
            }
        }
    }
    return 'localhost';
}

function showHelp() {
    console.log(`
ClusterODM Node Auto-Registration Client

Usage: node register-node.js [options]

Options:
    --cluster-host <host>         ClusterODM hostname (default: localhost, env: CLUSTER_HOST)
    --cluster-port <port>         ClusterODM admin web port (default: 10000, env: CLUSTER_PORT)
    --node-host <host>            This node's hostname (default: auto-detect, env: NODE_HOST)
    --node-port <port>            This node's port (default: 3000, env: NODE_PORT)
    --node-token <token>          NodeODM authentication token (default: none, env: NODE_TOKEN)
    --registration-secret <secret> Shared secret for registration (default: none, env: REGISTRATION_SECRET)
    --tapis-token <token>         Tapis JWT token for authentication (default: none, env: TAPIS_TOKEN)
    --node-id <id>                Node ID for de-registration (default: none, env: NODE_ID)
    --retries <number>            Number of retry attempts (default: 5)
    --retry-delay <seconds>       Delay between retries in seconds (default: 10)
    --deregister                  De-register node instead of registering
    --help, -h                    Show this help message

Environment Variables:
    All options can be set via environment variables as shown in parentheses.
    TAPIS_TOKEN: Preferred for Tapis-based deployments (alternative to --tapis-token)

Examples:
    # Basic registration with auto-detected IP
    node register-node.js --cluster-host clusterodm.example.com

    # Registration with Tapis JWT token (recommended for Tapis deployments)
    node register-node.js \\
        --cluster-host clusterodm.example.com \\
        --cluster-port 10000 \\
        --node-host 192.168.1.100 \\
        --node-port 3000 \\
        --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."

    # Registration with traditional secret
    node register-node.js \\
        --cluster-host clusterodm.example.com \\
        --registration-secret mySecretKey

    # Using environment variables (Tapis)
    export CLUSTER_HOST=clusterodm.example.com
    export NODE_HOST=192.168.1.100
    export TAPIS_TOKEN="eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."
    node register-node.js

    # Using environment variables (traditional)
    export CLUSTER_HOST=clusterodm.example.com
    export NODE_HOST=192.168.1.100
    export REGISTRATION_SECRET=mySecretKey
    node register-node.js

    # De-registration examples
    node register-node.js \\
        --cluster-host clusterodm.example.com \\
        --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..." \\
        --deregister

    # De-registration with node ID (most reliable)
    node register-node.js \\
        --cluster-host clusterodm.example.com \\
        --node-id 3 \\
        --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..." \\
        --deregister

    # With retry configuration
    node register-node.js \\
        --cluster-host clusterodm.example.com \\
        --retries 10 \\
        --retry-delay 30
`);
}

async function deregisterNode(args) {
    const deregistrationUrl = `http://${args.clusterHost}:${args.clusterPort}/webhook/deregister-node`;

    const payload = {
        hostname: args.nodeHost,
        port: parseInt(args.nodePort)
    };

    // Add node ID if provided (most reliable identification)
    if (args.nodeId) {
        payload.nodeId = parseInt(args.nodeId);
    }

    // Add authentication - prefer Tapis token, fallback to registration secret
    if (args.tapisToken) {
        payload.tapisToken = args.tapisToken;
    } else if (args.registrationSecret) {
        payload.registrationSecret = args.registrationSecret;
    }

    console.log(`Attempting to de-register node ${args.nodeHost}:${args.nodePort} from cluster at ${args.clusterHost}:${args.clusterPort}`);

    for (let attempt = 1; attempt <= args.retries; attempt++) {
        try {
            console.log(`De-registration attempt ${attempt}/${args.retries}...`);

            const response = await axios.post(deregistrationUrl, payload, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.success) {
                console.log(`✅ Successfully de-registered!`);
                console.log(`   Node: ${response.data.nodeInfo}`);
                console.log(`   Message: ${response.data.message}`);
                return true;
            } else {
                console.log(`⚠️  De-registration failed: ${response.data.error}`);
            }
        } catch (error) {
            if (error.response) {
                if (error.response.status === 404) {
                    console.log(`⚠️  Node not found in cluster (may already be removed)`);
                    return true; // Consider this successful since node is not registered
                }
                console.log(`❌ De-registration failed (HTTP ${error.response.status}): ${error.response.data?.error || error.message}`);

                if (error.response.status === 401) {
                    console.log('   Check your authentication credentials.');
                    break; // Don't retry on auth errors
                }
            } else if (error.code === 'ECONNREFUSED') {
                console.log(`❌ Cannot connect to ClusterODM at ${args.clusterHost}:${args.clusterPort}`);
                console.log('   Make sure ClusterODM is running and accessible.');
            } else {
                console.log(`❌ De-registration failed: ${error.message}`);
            }
        }

        if (attempt < args.retries) {
            console.log(`   Retrying in ${args.retryDelay} seconds...`);
            await new Promise(resolve => setTimeout(resolve, args.retryDelay * 1000));
        }
    }

    console.log(`❌ Failed to de-register after ${args.retries} attempts`);
    return false;
}

async function registerNode(args) {
    const registrationUrl = `http://${args.clusterHost}:${args.clusterPort}/webhook/register-node`;

    const payload = {
        hostname: args.nodeHost,
        port: parseInt(args.nodePort),
        token: args.nodeToken
    };

    // Add authentication - prefer Tapis token, fallback to registration secret
    if (args.tapisToken) {
        payload.tapisToken = args.tapisToken;
    } else if (args.registrationSecret) {
        payload.registrationSecret = args.registrationSecret;
    }

    console.log(`Attempting to register node ${args.nodeHost}:${args.nodePort} with cluster at ${args.clusterHost}:${args.clusterPort}`);

    for (let attempt = 1; attempt <= args.retries; attempt++) {
        try {
            console.log(`Registration attempt ${attempt}/${args.retries}...`);

            const response = await axios.post(registrationUrl, payload, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.success) {
                console.log(`✅ Successfully registered! Node ID: ${response.data.nodeId}`);
                console.log(`   Message: ${response.data.message}`);
                return true;
            } else {
                console.log(`⚠️  Registration failed: ${response.data.error}`);
                if (response.data.error.includes('already exists')) {
                    console.log('   Node is already registered, considering this successful.');
                    return true;
                }
            }
        } catch (error) {
            if (error.response) {
                console.log(`❌ Registration failed (HTTP ${error.response.status}): ${error.response.data?.error || error.message}`);

                if (error.response.status === 401) {
                    console.log('   Check your registration secret.');
                    break; // Don't retry on auth errors
                }
            } else if (error.code === 'ECONNREFUSED') {
                console.log(`❌ Cannot connect to ClusterODM at ${args.clusterHost}:${args.clusterPort}`);
                console.log('   Make sure ClusterODM is running and accessible.');
            } else {
                console.log(`❌ Registration failed: ${error.message}`);
            }
        }

        if (attempt < args.retries) {
            console.log(`   Retrying in ${args.retryDelay} seconds...`);
            await new Promise(resolve => setTimeout(resolve, args.retryDelay * 1000));
        }
    }

    console.log(`❌ Failed to register after ${args.retries} attempts`);
    return false;
}

async function validateNodeIsRunning(args) {
    try {
        console.log(`Checking if NodeODM is running on ${args.nodeHost}:${args.nodePort}...`);

        const response = await axios.get(`http://${args.nodeHost}:${args.nodePort}/info`, {
            timeout: 10000
        });

        if (response.data && response.data.version) {
            console.log(`✅ NodeODM is running (version ${response.data.version})`);
            return true;
        }
    } catch (error) {
        console.log(`⚠️  Cannot reach NodeODM at ${args.nodeHost}:${args.nodePort}: ${error.message}`);
        console.log('   Proceeding anyway, ClusterODM will verify connectivity.');
    }

    return false;
}

async function main() {
    const args = parseArgs();

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    if (!args.clusterHost) {
        console.error('❌ Error: --cluster-host is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }

    const isDeregistration = args.deregister;
    const title = isDeregistration ? 'ClusterODM Node De-Registration Client' : 'ClusterODM Node Auto-Registration Client';

    console.log(`🚀 ${title}`);
    console.log('==========================================');
    console.log(`Cluster: ${args.clusterHost}:${args.clusterPort}`);
    console.log(`Node: ${args.nodeHost}:${args.nodePort}`);
    if (isDeregistration && args.nodeId) {
        console.log(`Node ID: ${args.nodeId}`);
    }
    console.log(`Token: ${args.nodeToken ? '***set***' : 'none'}`);
    console.log(`Auth: ${args.tapisToken ? 'Tapis JWT' : args.registrationSecret ? 'Secret' : 'none'}`);
    console.log('');

    if (isDeregistration) {
        // Attempt de-registration
        const success = await deregisterNode(args);

        if (success) {
            console.log('✅ Node de-registration completed successfully!');
            process.exit(0);
        } else {
            console.log('❌ Node de-registration failed!');
            process.exit(1);
        }
    } else {
        // Optional: Check if NodeODM is running locally for registration
        await validateNodeIsRunning(args);

        // Attempt registration
        const success = await registerNode(args);

        if (success) {
            console.log('✅ Node registration completed successfully!');
            process.exit(0);
        } else {
            console.log('❌ Node registration failed!');
            process.exit(1);
        }
    }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
    console.log('\n🛑 Registration cancelled by user');
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Registration terminated');
    process.exit(1);
});

// Run the main function
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Unexpected error:', error.message);
        process.exit(1);
    });
}

module.exports = { registerNode, deregisterNode, parseArgs, getLocalIP };