const assert = require('assert');
const TapisAsrProvider = require('../libs/asr-providers/tapis');

(async () => {
    try {
        const provider = new TapisAsrProvider();
        provider.config.app.appId = 'nodeodm-ls62';
        provider.config.jobListLimit = 2;
        provider.config.jobListMaxPages = 4;

        const responses = [
            {
                data: {
                    result: [
                        { uuid: 'job-1', appId: 'nodeodm-ls62', status: 'RUNNING' },
                        { uuid: 'job-2', appId: 'nodeodm-ls62', status: 'FINISHED' }
                    ]
                }
            },
            {
                data: {
                    result: {
                        jobs: [
                            { uuid: 'job-3', appId: 'other-app', name: 'clusterodm-100-abcd', status: 'QUEUED' },
                            { uuid: 'job-4', appId: 'other-app', description: 'ClusterODM NodeODM instance', status: 'archiving' }
                        ]
                    }
                }
            },
            {
                data: {
                    result: [
                        { uuid: 'job-1', appId: 'nodeodm-ls62', status: 'RUNNING' },
                        { uuid: 'job-5', appId: 'other-app', name: 'unrelated', status: 'RUNNING' }
                    ]
                }
            }
        ];

        const calls = [];
        provider.createApiClient = () => ({
            get: async (endpoint, options) => {
                calls.push({ endpoint, options });
                return responses.shift() || { data: { result: [] } };
            }
        });

        const count = await provider.countActiveJobsForToken('token');

        assert.strictEqual(count, 3);
        assert.strictEqual(calls.length, 4);
        assert.strictEqual(calls[0].endpoint, '/v3/jobs/list');
        assert.deepStrictEqual(calls[0].options.params, { limit: 2, skip: 0 });
        assert.deepStrictEqual(calls[1].options.params, { limit: 2, skip: 2 });
        assert.deepStrictEqual(calls[2].options.params, { limit: 2, skip: 4 });

        console.log('TAPIS ACTIVE JOBS TEST PASSED');
        process.exit(0);
    } catch (err) {
        console.error('TAPIS ACTIVE JOBS TEST FAILED:', err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '');
        process.exit(2);
    }
})();
