const assert = require('assert');
const http = require('http');
const adminweb = require('../adminweb');
const nodes = require('../libs/nodes');

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = payload => `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;

const request = (port, path, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: {
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
            ...(options.headers || {}),
        },
    }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
        }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});

const cookieFrom = response => (response.headers['set-cookie'] || [])[0]?.split(';')[0];

(async () => {
    const validToken = tokenFor({
        'tapis/username': 'alice',
        'tapis/user_id': 'alice-id',
        'tapis/tenant_id': 'portals',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
    });
    const expiredToken = tokenFor({
        'tapis/username': 'alice',
        'tapis/tenant_id': 'portals',
        exp: Math.floor(Date.now() / 1000) - 1,
    });

    const server = await adminweb.create({
        port: 0,
        sessionSecret: 'test-session-secret',
        registrationSecret: 'registration-secret',
        tapisJwt: {
            enabled: true,
            allowedTenants: ['portals'],
            allowedUsers: ['alice'],
        },
        validateTapisToken: async token => {
            if (token !== validToken && token !== expiredToken) {
                const error = new Error('invalid');
                error.code = 'INVALID_TOKEN';
                throw error;
            }
            return true;
        },
    });
    const port = server.address().port;
    const cleanupNode = () => {
        const node = nodes.find(candidate => candidate.hostname() === '127.0.0.1' && candidate.port() === 59123);
        if (node) nodes.remove(node);
    };

    try {
        const shell = await request(port, '/');
        assert.strictEqual(shell.status, 200);
        const loginSource = await request(port, '/component/loginForm.mjs');
        assert.strictEqual(loginSource.status, 200);
        assert.match(loginSource.body, /id="login-token"/);

        const config = await request(port, '/auth/config');
        assert.deepStrictEqual(JSON.parse(config.body), { mode: 'tapis-jwt' });

        const unauthenticated = await request(port, '/r/info');
        assert.strictEqual(unauthenticated.status, 401);

        const uuidOnly = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: { hostname: '127.0.0.1', port: 59123, registrationUuid: '00000000-0000-0000-0000-000000000000' },
        });
        assert.strictEqual(uuidOnly.status, 401);

        const ownerOnly = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: { hostname: '127.0.0.1', port: 59123, tapisJobOwner: 'alice' },
        });
        assert.strictEqual(ownerOnly.status, 401);

        const forged = await request(port, '/auth/login', {
            method: 'POST',
            body: { token: tokenFor({ 'tapis/username': 'alice', 'tapis/tenant_id': 'portals', exp: Math.floor(Date.now() / 1000) + 3600 }) },
        });
        assert.strictEqual(forged.status, 401);

        const expired = await request(port, '/auth/login', { method: 'POST', body: { token: expiredToken } });
        assert.strictEqual(expired.status, 401);

        const login = await request(port, '/auth/login', { method: 'POST', body: { token: validToken } });
        assert.strictEqual(login.status, 200);
        const sessionCookie = cookieFrom(login);
        assert.ok(sessionCookie);

        const session = await request(port, '/auth/session', { headers: { cookie: sessionCookie } });
        assert.strictEqual(session.status, 200);
        assert.ok(!session.body.includes(validToken));

        const info = await request(port, '/r/info', { headers: { cookie: sessionCookie } });
        assert.strictEqual(info.status, 200);

        const foreignOrigin = await request(port, '/auth/login', {
            method: 'POST',
            headers: { origin: 'https://evil.example' },
            body: { token: validToken },
        });
        assert.strictEqual(foreignOrigin.status, 403);

        const secretRegistration = await request(port, '/webhook/register-node', {
            method: 'POST',
            body: { hostname: '127.0.0.1', port: 59123, registrationSecret: 'registration-secret', token: 'node-token' },
        });
        assert.strictEqual(secretRegistration.status, 200);
        assert.match(secretRegistration.body, /registration-secret/);
        cleanupNode();
    } finally {
        cleanupNode();
        await new Promise(resolve => server.close(resolve));
    }

    console.log('ADMIN WEB AUTH TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
