const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');
const tapisTaskOptions = require('../libs/tapisTaskOptions');

(async () => {
    const provider = new TapisProvider();
    provider.config = Object.assign({}, provider.config, {
        tapis: {
            baseUrl: 'https://example.tapis.io',
            tenantId: 'tacc'
        },
        app: {
            appId: 'nodeodm-ls62',
            appVersion: '1.0.12'
        },
        system: {
            executionSystemId: 'ls6',
            archiveSystemId: 'ls6',
            logicalQueue: 'vm-small',
            queueFilter: ['vm-small', 'normal', 'gpu-a100-small']
        },
        scheduler: {
            defaultAllocation: 'PT2050-DataX'
        },
        job: {
            maxJobTime: '02:00:00',
            nodeCount: 1,
            coresPerNode: 16,
            memoryMB: 30720,
            archiveOnAppError: true,
            maxNodesPerJob: 4
        },
        imageSizeMapping: [
            {
                maxImages: 100,
                jobCount: 1,
                nodeCount: 2,
                logicalQueue: 'normal',
                coresPerNode: 16,
                memoryMB: 30720,
                maxJobTime: '04:00:00'
            }
        ]
    });

    const clusterOptions = await provider.getClusterOptions(null);
    assert.strictEqual(clusterOptions.find(option => option.name === 'tapis-queue').value, 'vm-small');
    assert.deepStrictEqual(clusterOptions.find(option => option.name === 'tapis-queue').domain, ['vm-small', 'normal', 'gpu-a100-small']);
    assert.strictEqual(clusterOptions.find(option => option.name === 'tapis-max-run-time').value, '120');
    assert.strictEqual(clusterOptions.find(option => option.name === 'tapis-allocation').value, 'PT2050-DataX');
    assert.strictEqual(clusterOptions.find(option => option.name === 'tapis-node').value, '1');
    assert.strictEqual(clusterOptions.find(option => option.name === 'tapis-node').domain, 'integer: 1 <= x <= 4');
    assert.deepStrictEqual(clusterOptions.find(option => option.name === 'tapis-queue').defaultByImages, [{ maxImages: 100, value: 'normal' }]);
    assert.deepStrictEqual(clusterOptions.find(option => option.name === 'tapis-max-run-time').defaultByImages, [{ maxImages: 100, value: '240' }]);
    assert.deepStrictEqual(clusterOptions.find(option => option.name === 'tapis-node').defaultByImages, [{ maxImages: 100, value: '2' }]);

    const taskOptions = [
        { name: 'tapis-queue', value: 'gpu-a100-small' },
        { name: 'tapis-allocation', value: 'ABC123' },
        { name: 'tapis-max-run-time', value: '4000' },
        { name: 'tapis-node', value: '3' },
        { name: 'no-gpu', value: true },
        { name: 'pc-quality', value: 'high' }
    ];

    assert.strictEqual(provider.getEffectiveQueue(taskOptions, 10), 'gpu-a100-small');
    assert.strictEqual(provider.getEffectiveAllocation(taskOptions), 'ABC123');
    assert.strictEqual(provider.getEffectiveMaxMinutes(taskOptions, 10), 2880);
    assert.strictEqual(provider.getEffectiveNodeCount(taskOptions, 10), 3);

    const nodeOptions = tapisTaskOptions.applyGpuQueuePolicy(taskOptions, 'gpu-a100-small');
    assert.strictEqual(nodeOptions.find(option => option.name === 'tapis-queue'), undefined);
    assert.strictEqual(nodeOptions.find(option => option.name === 'tapis-allocation'), undefined);
    assert.strictEqual(nodeOptions.find(option => option.name === 'tapis-node'), undefined);
    assert.strictEqual(nodeOptions.find(option => option.name === 'no-gpu').value, false);

    let submittedPayload = null;
    provider.createApiClient = () => ({
        post: async (path, payload) => {
            submittedPayload = payload;
            return { data: { result: { uuid: 'job-uuid-1' } } };
        }
    });

    await provider.submitJobWithoutData('token', 'clusterodm-test', 10, taskOptions, {
        jobProps: provider.getJobPropertiesFor(10),
        requestedNodeCount: 1,
        maxNodesPerJob: 4,
        nodesToSubmit: 1,
        jobsToSubmit: 1,
        nodesForJob: 1,
        totalWorkerNodes: 1
    });

    assert.strictEqual(submittedPayload.execSystemLogicalQueue, 'gpu-a100-small');
    assert.strictEqual(submittedPayload.maxMinutes, 2880);
    assert.strictEqual(submittedPayload.nodeCount, 3);
    assert.strictEqual(submittedPayload.parameterSet.schedulerOptions[0].arg, '-A ABC123');

    console.log('TAPIS TASK OPTIONS TEST PASSED');
})().catch(err => {
    console.error('TAPIS TASK OPTIONS TEST FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
});
