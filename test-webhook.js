#!/usr/bin/env node

/**
 * Simple test script for the webhook registration endpoint
 */

const axios = require('axios');

async function testWebhookEndpoint() {
    console.log('🧪 Testing ClusterODM Webhook Registration Endpoint');
    console.log('==================================================');

    // Test data
    const clusterHost = 'localhost';
    const clusterPort = '10000';
    const testPayload = {
        hostname: '192.168.1.100',
        port: 3000,
        token: '',
        tapisToken: 'test-tapis-token-123'
    };

    const url = `http://${clusterHost}:${clusterPort}/webhook/register-node`;

    console.log(`Testing URL: ${url}`);
    console.log(`Payload:`, JSON.stringify(testPayload, null, 2));
    console.log('');

    try {
        console.log('Sending registration request...');

        const response = await axios.post(url, testPayload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ Success! HTTP ${response.status}`);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        return true;
    } catch (error) {
        if (error.response) {
            console.log(`❌ HTTP Error ${error.response.status}: ${error.response.statusText}`);
            console.log('Response:', JSON.stringify(error.response.data, null, 2));
        } else if (error.code === 'ECONNREFUSED') {
            console.log(`❌ Connection refused to ${clusterHost}:${clusterPort}`);
            console.log('Make sure ClusterODM is running with the admin web interface enabled.');
            console.log('Start it with: node index.js --admin-web-port 10000');
        } else {
            console.log(`❌ Error: ${error.message}`);
        }

        return false;
    }
}

async function testWithSecret() {
    console.log('\n🧪 Testing with registration secret');
    console.log('===================================');

    const clusterHost = 'localhost';
    const clusterPort = '10000';
    const testPayload = {
        hostname: '192.168.1.101',
        port: 3001,
        registrationSecret: 'test-secret'
    };

    const url = `http://${clusterHost}:${clusterPort}/webhook/register-node`;

    try {
        const response = await axios.post(url, testPayload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ Success! HTTP ${response.status}`);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        return true;
    } catch (error) {
        if (error.response) {
            console.log(`❌ HTTP Error ${error.response.status}: ${error.response.statusText}`);
            console.log('Response:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.log(`❌ Error: ${error.message}`);
        }

        return false;
    }
}

async function testInfoEndpoint() {
    console.log('\n🧪 Testing ClusterODM info endpoint');
    console.log('===================================');

    const clusterHost = 'localhost';
    const clusterPort = '10000';
    const url = `http://${clusterHost}:${clusterPort}/r/info`;

    try {
        const response = await axios.get(url, { timeout: 5000 });
        console.log(`✅ ClusterODM is running! Version: ${response.data.version}`);
        return true;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.log(`❌ Cannot connect to ClusterODM at ${clusterHost}:${clusterPort}`);
            console.log('Start ClusterODM with: node index.js --admin-web-port 10000');
        } else {
            console.log(`❌ Error: ${error.message}`);
        }
        return false;
    }
}

async function testDeregistration() {
    console.log('\n🧪 Testing node de-registration');
    console.log('================================');

    const clusterHost = 'localhost';
    const clusterPort = '10000';
    const testPayload = {
        hostname: '192.168.1.100',
        port: 3000,
        tapisToken: 'test-tapis-token-123'
    };

    const url = `http://${clusterHost}:${clusterPort}/webhook/deregister-node`;

    try {
        const response = await axios.post(url, testPayload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ De-registration response! HTTP ${response.status}`);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        return true;
    } catch (error) {
        if (error.response) {
            if (error.response.status === 404) {
                console.log(`✅ Expected 404 - node not found (this is normal for testing)`);
                console.log('Response:', JSON.stringify(error.response.data, null, 2));
                return true;
            }
            console.log(`❌ HTTP Error ${error.response.status}: ${error.response.statusText}`);
            console.log('Response:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.log(`❌ Error: ${error.message}`);
        }

        return false;
    }
}

async function main() {
    console.log('This script tests the webhook registration endpoint.');
    console.log('Make sure ClusterODM is running before executing this test.\n');

    // Test if ClusterODM is running
    const isRunning = await testInfoEndpoint();
    if (!isRunning) {
        console.log('\n❌ ClusterODM is not running. Please start it first.');
        process.exit(1);
    }

    // Test registration with Tapis token
    await testWebhookEndpoint();

    // Test registration with secret
    await testWithSecret();

    // Test de-registration
    await testDeregistration();

    console.log('\n✅ Test completed!');
    console.log('\nTo manually start ClusterODM for testing:');
    console.log('  node index.js --admin-web-port 10000 --registration-secret test-secret');
}

if (require.main === module) {
    main().catch(error => {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    });
}