const assert = require('assert');
const config = require('../config');
const taskNew = require('../libs/taskNew');

const original = config.path_forward_timeout_ms;

try {
    assert.strictEqual(taskNew.getPathForwardTimeoutMs(), 300000);

    config.path_forward_timeout_ms = 450000;
    assert.strictEqual(taskNew.getPathForwardTimeoutMs(), 450000);

    config.path_forward_timeout_ms = 999;
    assert.strictEqual(taskNew.getPathForwardTimeoutMs(), 300000);

    config.path_forward_timeout_ms = 'not-a-number';
    assert.strictEqual(taskNew.getPathForwardTimeoutMs(), 300000);

    console.log('PATH FORWARD TIMEOUT TEST PASSED');
} catch (err) {
    console.error('PATH FORWARD TIMEOUT TEST FAILED:', err && err.message ? err.message : err);
    process.exitCode = 2;
} finally {
    config.path_forward_timeout_ms = original;
}
