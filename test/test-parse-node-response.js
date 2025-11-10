const assert = require('assert');

(async () => {
    try {
        const { parseNodeTaskResponse } = require('../libs/taskNew');
        const ok = parseNodeTaskResponse({ data: { uuid: '1234' } });
        assert.strictEqual(ok.uuid, '1234');

        const okBare = parseNodeTaskResponse({ uuid: 'abcd' });
        assert.strictEqual(okBare.uuid, 'abcd');

        assert.throws(() => parseNodeTaskResponse({ data: { error: 'boom' } }), /boom/);
        assert.throws(() => parseNodeTaskResponse({ data: { hello: 'world' } }), /missing uuid/);

        console.log('PARSE NODE RESPONSE TEST PASSED');
        process.exit(0);
    } catch (err) {
        console.error('PARSE NODE RESPONSE TEST FAILED:', err && err.message ? err.message : err);
        process.exit(2);
    }
})();
