const assert = require('assert');
const path = require('path');

// Load config and set test mappings before requiring taskNew
const config = require('../config');

// Test mapping values
const SRC = '/corral/webodm/media';
const DST = '/corral-repl/tacc/aci/PT2050/projects/PTDATAX-263/webodm/media';

// Helper to reset mapping
function setMapping(mapping){
    config.node_shared_path_mappings = mapping;
}

// Test cases
(async () => {
    try {
        // Case 1: exact hostname mapping
        setMapping({
            'nodeodm-ls6': {
                [SRC]: DST
            }
        });

        // Require after config is set so the module sees the mapping
        const taskNew = require('../libs/taskNew');
        const translate = taskNew.translateImportPathForNode;

        const inPath = SRC + '/projects/ABC/images';
        const out = translate(inPath, 'nodeodm-ls6');
        assert.strictEqual(out, path.normalize(DST + '/projects/ABC/images'));

        // Case 2: short hostname (strip domain)
        setMapping({
            'nodeodm-ls6': {
                [SRC]: DST
            }
        });
        const out2 = translate(inPath, 'nodeodm-ls6.example.edu');
        assert.strictEqual(out2, path.normalize(DST + '/projects/ABC/images'));

        // Case 3: wildcard mapping
        setMapping({
            '*': {
                [SRC]: DST
            }
        });
        const out3 = translate(inPath, 'some-random-host');
        assert.strictEqual(out3, path.normalize(DST + '/projects/ABC/images'));

        // Case 4: no mapping found -> null
        setMapping({});
        const out4 = translate(inPath, 'nodeodm-ls6');
        assert.strictEqual(out4, null);

        // Case 5: path that doesn't start with source prefix -> null
        setMapping({ '*': { [SRC]: DST } });
        const out5 = translate('/other/prefix/data', 'nodeodm-ls6');
        assert.strictEqual(out5, null);

        console.log('ALL TESTS PASSED');
        process.exit(0);
    } catch (e) {
        console.error('TEST FAILED:', e && e.message ? e.message : e);
        console.error(e.stack);
        process.exit(2);
    }
})();
