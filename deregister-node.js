#!/usr/bin/env node
/**
 * Node De-Registration Client for ClusterODM-Tapis
 *
 * This script allows compute nodes to automatically de-register themselves
 * from the ClusterODM cluster when jobs complete or fail.
 *
 * Usage:
 *   node deregister-node.js --cluster-host <host> --cluster-port <port> [options]
 *
 * Environment Variables:
 *   CLUSTER_HOST: ClusterODM host (alternative to --cluster-host)
 *   CLUSTER_PORT: ClusterODM port (alternative to --cluster-port)
 *   NODE_HOST: This node's hostname (alternative to --node-host)
 *   NODE_PORT: This node's port (alternative to --node-port)
 *   NODE_ID: Node ID for more reliable identification (alternative to --node-id)
 *   TAPIS_TOKEN: Tapis JWT token (alternative to --tapis-token)
 *   REGISTRATION_SECRET: Shared secret (alternative to --registration-secret)
 */

// Import registration functions and reuse with --deregister flag
const { deregisterNode, parseArgs, getLocalIP } = require('./register-node');

async function main() {
    // Parse arguments and add --deregister flag
    const args = parseArgs();
    args.deregister = true;

    if (args.help) {
        console.log(`
ClusterODM Node De-Registration Client

Usage: node deregister-node.js [options]

Options:
    --cluster-host <host>         ClusterODM hostname (default: localhost, env: CLUSTER_HOST)
    --cluster-port <port>         ClusterODM admin web port (default: 10000, env: CLUSTER_PORT)
    --node-host <host>            This node's hostname (default: auto-detect, env: NODE_HOST)
    --node-port <port>            This node's port (default: 3000, env: NODE_PORT)
    --node-id <id>                Node ID for reliable identification (default: none, env: NODE_ID)
    --tapis-token <token>         Tapis JWT token for authentication (default: none, env: TAPIS_TOKEN)
    --registration-secret <secret> Shared secret for authentication (default: none, env: REGISTRATION_SECRET)
    --retries <number>            Number of retry attempts (default: 5)
    --retry-delay <seconds>       Delay between retries in seconds (default: 10)
    --help, -h                    Show this help message

Environment Variables:
    All options can be set via environment variables as shown in parentheses.

Examples:
    # Basic de-registration (finds node by hostname:port)
    node deregister-node.js --cluster-host clusterodm.example.com

    # De-registration with Tapis JWT token
    node deregister-node.js \\
        --cluster-host clusterodm.example.com \\
        --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."

    # De-registration with node ID (most reliable)
    node deregister-node.js \\
        --cluster-host clusterodm.example.com \\
        --node-id 3 \\
        --tapis-token "eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."

    # Using environment variables
    export CLUSTER_HOST=clusterodm.example.com
    export NODE_ID=3
    export TAPIS_TOKEN="eyJ0eXAiOiJKV1QiOiJhbGciOiJSUzI1NiJ9..."
    node deregister-node.js

HPC Integration:
    # Add to job cleanup/exit handler
    trap 'node deregister-node.js --cluster-host head-node.cluster.edu' EXIT

    # Use in SLURM job script cleanup
    cleanup() {
        node deregister-node.js \\
            --cluster-host "\$CLUSTER_HOST" \\
            --tapis-token "\$TAPIS_TOKEN"
    }
    trap cleanup EXIT SIGTERM SIGINT
`);
        process.exit(0);
    }

    if (!args.clusterHost) {
        console.error('❌ Error: --cluster-host is required');
        console.error('Use --help for usage information');
        process.exit(1);
    }

    console.log('🔄 ClusterODM Node De-Registration Client');
    console.log('=========================================');
    console.log(`Cluster: ${args.clusterHost}:${args.clusterPort}`);
    console.log(`Node: ${args.nodeHost}:${args.nodePort}`);
    if (args.nodeId) {
        console.log(`Node ID: ${args.nodeId}`);
    }
    console.log(`Auth: ${args.tapisToken ? 'Tapis JWT' : args.registrationSecret ? 'Secret' : 'none'}`);
    console.log('');

    // Attempt de-registration
    const success = await deregisterNode(args);

    if (success) {
        console.log('✅ Node de-registration completed successfully!');
        process.exit(0);
    } else {
        console.log('❌ Node de-registration failed!');
        process.exit(1);
    }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
    console.log('\\n🛑 De-registration cancelled by user');
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('\\n🛑 De-registration terminated');
    process.exit(1);
});

// Run the main function
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Unexpected error:', error.message);
        process.exit(1);
    });
}