const assert = require('assert');
const TapisProvider = require('../libs/asr-providers/tapis');

function makeToken(username, tenant = 'portals') {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    const payload = Buffer.from(JSON.stringify({
        'tapis/username': username,
        'tapis/tenant_id': tenant,
        exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return `${header}.${payload}.signature`;
}

(() => {
    const provider = new TapisProvider();
    provider.config = Object.assign({}, provider.config, {
        checkpoint: Object.assign({}, provider.config.checkpoint || {}, {
            scratchRoots: ['/scratch/06659/wmobley', '/work/06659/wmobley']
        })
    });

    assert.strictEqual(
        provider.isAllowedScratchResumePath('/scratch/06659/wmobley/tapis/job/runtime/data/task'),
        true
    );
    assert.strictEqual(
        provider.isAllowedScratchResumePath('/scratch/06659/wmobley2/tapis/job/runtime/data/task'),
        false
    );
    assert.strictEqual(
        provider.isAllowedScratchResumePath('/corral/webodm/media/.nodeodm-checkpoints/task'),
        false
    );
    assert.strictEqual(provider.isAllowedScratchResumePath('relative/path'), false);

    provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'wmobley' }, makeToken('wmobley'));
    assert.throws(
        () => provider.assertCheckpointOwner({ uuid: 'task', tapisJobOwner: 'otheruser' }, makeToken('wmobley')),
        /belongs to otheruser/
    );

    console.log('TAPIS CHECKPOINT RESUME TEST PASSED');
})();
