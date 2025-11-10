const assert = require('assert');
const taskNew = require('../libs/taskNew');

const parseNodeTaskResponse = taskNew.parseNodeTaskResponse;

(async () => {
    try {
        const ok = parseNodeTaskResponse({ data: { uuid: '1234' } });
        assert.strictEqual(ok.uuid, '1234');

        assert.throws(() => parseNodeTaskResponse({ data: { error: 'boom' } }), /boom/);
        assert.throws(() => parseNodeTaskResponse({ data: { hello: 'world' } }), /missing uuid/);

        console.log('PARSE NODE RESPONSE TEST PASSED');
        process.exit(0);
    } catch (err) {
        console.error('PARSE NODE RESPONSE TEST FAILED:', err && err.message ? err.message : err);
        process.exit(2);
    }
})();
