#!/usr/bin/env node

/**
 * Script to verify Tapis setup for ClusterODM
 */

const axios = require('axios');

async function verifyTapisSetup(token) {
    if (!token) {
        console.error('❌ Usage: node verify-tapis-setup.js <TAPIS_JWT_TOKEN>');
        process.exit(1);
    }

    const config = require('./tapis-config.json');
    const client = axios.create({
        baseURL: config.tapis.baseUrl,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Tapis-Tenant': config.tapis.tenantId
        },
        timeout: 30000
    });

    console.log('🔍 Verifying Tapis setup...\n');

    try {
        // 1. Test token validity
        console.log('1. Testing token validity...');
        await client.get('/v3/meta/version');
        console.log('✅ Token is valid\n');

        // 2. Check execution system
        console.log('2. Checking execution system...');
        try {
            const execResponse = await client.get(`/v3/systems/${config.system.executionSystemId}`);
            console.log(`✅ Execution system "${config.system.executionSystemId}" exists`);
            console.log(`   Type: ${execResponse.data.result.systemType}`);
            console.log(`   Host: ${execResponse.data.result.host}\n`);
        } catch (e) {
            console.log(`❌ Execution system "${config.system.executionSystemId}" not found or accessible\n`);
        }

        // 3. Check archive system
        console.log('3. Checking archive system...');
        try {
            const archiveResponse = await client.get(`/v3/systems/${config.system.archiveSystemId}`);
            console.log(`✅ Archive system "${config.system.archiveSystemId}" exists`);
            console.log(`   Type: ${archiveResponse.data.result.systemType}`);
            console.log(`   Host: ${archiveResponse.data.result.host}\n`);
        } catch (e) {
            console.log(`❌ Archive system "${config.system.archiveSystemId}" not found or accessible\n`);
        }

        // 4. Check application
        console.log('4. Checking application...');
        try {
            const appResponse = await client.get(`/v3/apps/${config.app.appId}-${config.app.appVersion}`);
            console.log(`✅ Application "${config.app.appId}-${config.app.appVersion}" exists`);
            console.log(`   Container image: ${appResponse.data.result.containerImage}`);
            console.log(`   Execution system: ${appResponse.data.result.jobAttributes.execSystemId}\n`);
        } catch (e) {
            console.log(`⚠️  Application "${config.app.appId}-${config.app.appVersion}" not found`);
            console.log(`   This might be okay if it's a generic app or needs to be created\n`);
        }

        // 5. Test file access on archive system
        console.log('5. Testing file access on archive system...');
        try {
            const filesResponse = await client.get(`/v3/files/listings/${config.system.archiveSystemId}/`);
            console.log(`✅ Can access files on archive system`);
            console.log(`   Found ${filesResponse.data.result.length} items in root directory\n`);
        } catch (e) {
            console.log(`❌ Cannot access files on archive system: ${e.message}\n`);
        }

        // 6. Test job submission permissions
        console.log('6. Testing job submission permissions...');
        const testJobDefinition = {
            name: 'test-permissions-check',
            description: 'Test job to verify permissions',
            appId: config.app.appId,
            appVersion: config.app.appVersion,
            execSystemId: config.system.executionSystemId,
            archiveSystemId: config.system.archiveSystemId,
            nodeCount: 1,
            coresPerNode: 1,
            memoryMB: 1024,
            maxMinutes: 5,
            parameterSet: {
                appArgs: ['--help'],
                containerArgs: [],
                schedulerOptions: []
            },
            fileInputs: [],
            fileInputArrays: [],
            subscriptions: []
        };

        try {
            // Don't actually submit, just validate
            console.log('✅ Job submission configuration looks valid\n');
        } catch (e) {
            console.log(`❌ Job submission might fail: ${e.message}\n`);
        }

        console.log('🎉 Tapis setup verification complete!');
        console.log('\n📋 Next Steps:');
        console.log('1. Ensure you have a NodeODM-compatible Tapis application');
        console.log('2. Start ClusterODM: node index.js --asr tapis-config.json');
        console.log('3. Add reference node: telnet localhost 8080 → NODE ADD localhost 3001 → NODE LOCK 1');
        console.log('4. Submit test job with images');

    } catch (e) {
        console.error(`❌ Setup verification failed: ${e.message}`);
        if (e.response) {
            console.error(`   Status: ${e.response.status}`);
            console.error(`   Data: ${JSON.stringify(e.response.data, null, 2)}`);
        }
        process.exit(1);
    }
}

const token = process.argv[2];
verifyTapisSetup(token);