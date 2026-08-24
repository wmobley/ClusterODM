const assert = require('assert');
const config = require('../config');

(async () => {
    try {
        assert.ok(config.node_shared_path_mappings, 'node_shared_path_mappings should be defined');
        assert.strictEqual(typeof config.node_shared_path_mappings, 'object', 'node_shared_path_mappings should remain an object');
        console.log('CONFIG NODE SHARED PATH TEST PASSED');
        process.exit(0);
    } catch (err) {
        console.error('CONFIG NODE SHARED PATH TEST FAILED:', err && err.message ? err.message : err);
        process.exit(2);
    }
})();
