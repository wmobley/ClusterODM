const assert = require('assert');
const net = require('net');
const admincli = require('../admincli');

let occupied;

(async () => {
    await assert.rejects(
        () => admincli.create({port: 0, password: ''}),
        error => error && error.code === 'ADMIN_CLI_PASSWORD_REQUIRED'
    );

    occupied = net.createServer();
    await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
    });

    const port = occupied.address().port;
    let candidate;
    try {
        candidate = await admincli.create({port, password: 'test-password'});
        assert.fail('admin CLI unexpectedly bound an occupied port');
    } catch (error){
        assert.strictEqual(error && error.code, 'EADDRINUSE');
    } finally {
        if (candidate && candidate.listening){
            await new Promise(resolve => candidate.close(resolve));
        }
    }

    console.log('ADMIN CLI PORT TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(async () => {
    if (occupied && occupied.listening){
        await new Promise(resolve => occupied.close(resolve));
    }
});
