const assert = require('assert');
const path = require('path');
const config = require('../config');
const taskNew = require('../libs/taskNew');
const translate = taskNew.translateImportPathForNode;

const SRC = '/corral/webodm/media';
const DST = '/corral-repl/tacc/aci/PT2050/projects/PTDATAX-263/webodm/media';

function setMapping(m){ config.node_shared_path_mappings = m; }

try{
    // Overlapping prefixes: longest match should be applied if both present
    setMapping({
        '*': {
            '/corral/webodm': '/fallback'
        },
        'nodeodm-ls6': {
            '/corral/webodm/media': DST
        }
    });

    const inPath = SRC + '/projects/XYZ';
    const out = translate(inPath, 'nodeodm-ls6');
    assert.strictEqual(out, path.normalize(DST + '/projects/XYZ'));

    // Trailing slash handling: source prefix with trailing slash
    setMapping({ '*': { '/corral/webodm/media/': DST } });
    const out2 = translate(SRC + '/foo', 'anyhost');
    assert.strictEqual(out2, path.normalize(DST + '/foo'));

    // Dest with trailing slash normalization
    setMapping({ '*': { '/corral/webodm/media': DST + '/' } });
    const out3 = translate(SRC + '/bar', 'anyhost');
    assert.strictEqual(out3, path.normalize(DST + '/bar'));

    // Multiple overlapping entries - exact host should win over wildcard
    setMapping({
        '*': { [SRC]: '/other/default' },
        'special-host': { [SRC]: DST }
    });
    const out4 = translate(SRC + '/a', 'special-host');
    assert.strictEqual(out4, path.normalize(DST + '/a'));

    // Path exactly equals source prefix -> translated should equal dest prefix
    setMapping({ '*': { [SRC]: DST } });
    const out5 = translate(SRC, 'nodeodm-ls6');
    assert.strictEqual(out5, path.normalize(DST));

    console.log('EDGE TESTS PASSED');
    process.exit(0);
}catch(e){
    console.error('EDGE TESTS FAILED:', e && e.message ? e.message : e);
    console.error(e.stack);
    process.exit(2);
}
